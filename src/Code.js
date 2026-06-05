/**
 * Core script for the Email Notice Auditor.
 * Processes incoming and outgoing emails, categorizes them using Gemini,
 * extracts summaries and action items, and semantically links replies.
 */

// Retrieve the Gemini API Key from Script Properties
function getGeminiApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set in Script Properties. Please go to Project Settings (gear icon) -> Script Properties and add it.");
  }
  return key;
}

/**
 * Main entry point. Fetches and processes emails incrementally.
 */
function processEmails() {
  Logger.log("Starting email audit run...");
  
  // 1. Get or create the Google Sheet database
  const sheet = getDatabaseSheet();
  
  // 2. Load existing records to prevent duplicates and look up pending items
  const db = loadDatabaseRecords(sheet);
  Logger.log("Loaded " + db.records.length + " existing records from sheet. Pending notices count: " + db.pendingNotices.length);
  
  // 3. Determine the last processed timestamp
  const userProperties = PropertiesService.getUserProperties();
  let lastProcessedTime = parseInt(userProperties.getProperty("LAST_PROCESSED_TIMESTAMP"), 10);
  
  if (!lastProcessedTime || isNaN(lastProcessedTime)) {
    // If running for the first time, look back 7 days
    lastProcessedTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
    Logger.log("No last processed timestamp found. Starting from 7 days ago.");
  } else {
    Logger.log("Resuming processing from last timestamp: " + new Date(lastProcessedTime).toISOString());
  }
  
  // Search Gmail for both incoming and outgoing messages since last run (formatted as YYYY/MM/DD)
  // We search 1 day before the timestamp to be safe against timezone boundaries, then filter precisely in code.
  const searchDate = new Date(lastProcessedTime - 24 * 60 * 60 * 1000);
  const formattedSearchDate = searchDate.getFullYear() + "/" + (searchDate.getMonth() + 1) + "/" + searchDate.getDate();
  
  // Exclude promotions, social, and specific sender karang@sgfinfra.com
  const incomingQuery = `in:inbox -category:promotions -category:social -from:karang@sgfinfra.com after:${formattedSearchDate}`;
  const outgoingQuery = `in:sent after:${formattedSearchDate}`;
  
  Logger.log("Searching incoming: " + incomingQuery);
  Logger.log("Searching outgoing: " + outgoingQuery);
  
  const incomingThreads = GmailApp.search(incomingQuery, 0, 100);
  const outgoingThreads = GmailApp.search(outgoingQuery, 0, 100);
  
  // Collect all messages that are newer than lastProcessedTime and not already in the sheet
  const messagesToProcess = [];
  
  // Collect Incoming
  incomingThreads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const msgTime = msg.getDate().getTime();
      const msgId = msg.getId();
      if (msgTime > lastProcessedTime && !db.recordsMap[msgId]) {
        messagesToProcess.push({
          message: msg,
          type: "INCOMING",
          time: msgTime
        });
      }
    });
  });
  
  // Collect Outgoing
  outgoingThreads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const msgTime = msg.getDate().getTime();
      const msgId = msg.getId();
      if (msgTime > lastProcessedTime && !db.recordsMap[msgId]) {
        messagesToProcess.push({
          message: msg,
          type: "OUTGOING",
          time: msgTime
        });
      }
    });
  });
  
  // Sort messages chronologically (oldest first) so we process and save state sequentially
  messagesToProcess.sort((a, b) => a.time - b.time);
  Logger.log("Found " + messagesToProcess.length + " new messages to process.");
  
  if (messagesToProcess.length === 0) {
    Logger.log("No new emails to process.");
    return;
  }
  
  const apiKey = getGeminiApiKey();
  let maxTimeSaved = lastProcessedTime;
  
  for (let i = 0; i < messagesToProcess.length; i++) {
    const item = messagesToProcess[i];
    const msg = item.message;
    const msgId = msg.getId();
    const threadId = msg.getThread().getId();
    const date = msg.getDate();
    const subject = msg.getSubject();
    const sender = msg.getFrom();
    const body = msg.getPlainBody() || "";
    
    Logger.log(`Processing (${item.type}) [${i+1}/${messagesToProcess.length}] Subject: "${subject}" from/to: ${sender}`);
    
    // Extract attachments (Focusing on PDFs and Images under 3.5MB)
    const attachments = msg.getAttachments();
    const attachmentNames = attachments.map(a => a.getName()).join(", ");
    const attachmentParts = [];
    
    attachments.forEach(att => {
      const sizeMB = att.getSize() / (1024 * 1024);
      const mime = att.getContentType().toLowerCase();
      
      // Focus on PDFs and Image formats
      const isSupportedMime = mime.indexOf("pdf") !== -1 || mime.indexOf("image") !== -1;
      
      if (isSupportedMime && sizeMB < 3.5) {
        try {
          const base64 = Utilities.base64Encode(att.getBytes());
          attachmentParts.push({
            inlineData: {
              mimeType: att.getContentType(),
              data: base64
            }
          });
          Logger.log(`Attached file: "${att.getName()}" (${mime}, ${sizeMB.toFixed(2)} MB) encoded for Gemini.`);
        } catch (err) {
          Logger.log(`Skipped encoding for "${att.getName()}": ${err.message}`);
        }
      } else {
        Logger.log(`Skipped attachment "${att.getName()}" (Unsupported format or size: ${sizeMB.toFixed(2)} MB)`);
      }
    });
    
    if (item.type === "INCOMING") {
      // 4. Process Incoming Email
      const analysis = analyzeIncomingEmail(apiKey, sender, subject, body, attachmentNames, attachmentParts);
      
      let status = "No Action Needed";
      if (analysis.replyRequired) {
        status = "Pending";
      }
      
      const newRow = [
        msgId,
        threadId,
        "INCOMING",
        date,
        sender,
        subject,
        body.substring(0, 1000), // Truncate slightly in sheet cell
        attachmentNames,
        analysis.category,
        analysis.summary,
        analysis.expectedAction,
        analysis.replyRequired ? "Yes" : "No",
        status,
        "" // Matched Reply ID
      ];
      
      sheet.appendRow(newRow);
      
      // Add to local list of pending notices if it requires a reply
      if (status === "Pending") {
        db.pendingNotices.push({
          rowNum: sheet.getLastRow(),
          msgId: msgId,
          sender: sender,
          subject: subject,
          summary: analysis.summary
        });
      }
      
    } else {
      // 5. Process Outgoing Email
      // Match against existing pending notices using semantic analysis
      let matchedId = "";
      let matchedIndex = -1;
      
      if (db.pendingNotices.length > 0) {
        const matchResult = matchOutgoingToNotices(apiKey, sender, subject, body, attachmentNames, attachmentParts, db.pendingNotices);
        if (matchResult.isReply && matchResult.matchedIncomingMessageId) {
          matchedId = matchResult.matchedIncomingMessageId;
          matchedIndex = db.pendingNotices.findIndex(p => p.msgId === matchedId);
          
          if (matchedIndex !== -1) {
            const pendingNotice = db.pendingNotices[matchedIndex];
            Logger.log(`SUCCESS: Outgoing email matched to incoming notice ID ${matchedId} on row ${pendingNotice.rowNum}`);
            
            // Update the status of the matched notice row to "Replied"
            sheet.getRange(pendingNotice.rowNum, 13).setValue("Replied"); // Status column
            sheet.getRange(pendingNotice.rowNum, 14).setValue(msgId);     // Matched Reply ID column
            
            // Remove from local pending list
            db.pendingNotices.splice(matchedIndex, 1);
          }
        }
      }
      
      const newRow = [
        msgId,
        threadId,
        "OUTGOING",
        date,
        sender,
        subject,
        body.substring(0, 1000),
        attachmentNames,
        "N/A",
        `Sent email: ${subject}`,
        "N/A",
        "No",
        "No Action Needed",
        matchedId
      ];
      
      sheet.appendRow(newRow);
    }
    
    // Save state iteratively to ensure that if a run crashes, we don't restart from the beginning
    maxTimeSaved = item.time;
    userProperties.setProperty("LAST_PROCESSED_TIMESTAMP", maxTimeSaved.toString());
  }
  
  Logger.log("Finished email audit run. State updated to: " + new Date(maxTimeSaved).toISOString());
}

/**
 * Sends incoming email data to Gemini to extract metadata.
 */
function analyzeIncomingEmail(apiKey, sender, subject, body, attachmentNames, attachmentParts) {
  const prompt = `Analyze this incoming email (and any attached documents/images) for SGF Infra Private Limited.
Evaluate both the email body and the attachment content to categorize the email and extract key information.

Sender: ${sender}
Subject: ${subject}
Attachment Names: ${attachmentNames}
Email Body:
${body.substring(0, 3000)}

Instructions:
1. Categorize the email into exactly one of these categories:
   - Tenders & Bidding (Govt/e-Procurement details)
   - GST & Regulatory Compliance (Taxes, OTPs, CIBIL warnings)
   - Project Execution (Notices, Site instructions, Anchor blocks, Drawings, Blasting permits, BRO correspondence)
   - Vendor Quotations (Profiles, Scaffolding, price quotes, catalogs, cement reports)
   - HR & Administration (Staff queries, salaries, automated scripts)
   - Utility, Banking & Vendor Accounts (BSNL bills, Bank detail updates)
   - General News & PR (Publications, newsletters)
   - Other
   *Special Rule: If the email is from "bro-vjk@nic.in", classify it as "Project Execution".*
2. Identify if this email is a formal notice, correspondence, or invoice from a client/vendor/department that requires a reply or action from our office.
3. Write a concise summary and outline the expected action from us.

Return the result in JSON format matching this schema:
{
  "category": "String (one of the categories above)",
  "summary": "String (concise summary of the notice/attachment)",
  "expectedAction": "String (details of what we need to do)",
  "replyRequired": boolean (true if a reply/submission is required from our office, false otherwise)
}`;

  const parts = attachmentParts.concat([{ text: prompt }]);
  
  const responseText = callGeminiApi(apiKey, parts);
  try {
    return JSON.parse(responseText);
  } catch (e) {
    Logger.log("Failed to parse Gemini JSON output: " + responseText);
    return {
      category: "Other",
      summary: "Failed to parse summary. Subject: " + subject,
      expectedAction: "Review manually",
      replyRequired: false
    };
  }
}

/**
 * Matches an outgoing email semantically to one of our pending incoming notices.
 */
function matchOutgoingToNotices(apiKey, sender, subject, body, attachmentNames, attachmentParts, pendingNotices) {
  const noticesText = pendingNotices.map((n, idx) => {
    return `${idx + 1}. [Message ID: ${n.msgId}]
   From: ${n.sender}
   Subject: ${n.subject}
   Summary: ${n.summary}`;
  }).join("\n---\n");

  const prompt = `Review this outgoing email sent by our office (including any attachments) and decide if it is a reply or response to any of the pending incoming notices listed below.
  
Note: Our office does NOT always click "Reply". They might send a completely fresh email, but the subject line, email body, or attachment contents will refer to the same project, letter, or request.

---
OUTGOING EMAIL DETAILS:
To/From: ${sender}
Subject: ${subject}
Attachment Names: ${attachmentNames}
Body:
${body.substring(0, 3000)}
---

PENDING NOTICES LIST:
${noticesText}

Instructions:
1. Carefully compare the Outgoing Email (subject, project names mentioned in body, attachment file names, etc.) with the Pending Notices List.
2. Determine if this outgoing email is a response, document submission, or reply addressing one of the pending notices.
3. Return the result in JSON format matching this schema:
{
  "isReply": boolean (true if it matches one of the pending notices, false otherwise),
  "matchedIncomingMessageId": "String (the Message ID of the matched incoming notice, or null if no match)"
}`;

  const parts = attachmentParts.concat([{ text: prompt }]);
  const responseText = callGeminiApi(apiKey, parts);
  
  try {
    return JSON.parse(responseText);
  } catch (e) {
    Logger.log("Failed to parse matching Gemini JSON output: " + responseText);
    return {
      isReply: false,
      matchedIncomingMessageId: null
    };
  }
}

/**
 * Helper to call the Google Gemini API (gemini-3.5-flash)
 */
function callGeminiApi(apiKey, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };
  
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const resText = response.getContentText();
  
  if (code !== 200) {
    throw new Error(`Gemini API call failed with status ${code}: ${resText}`);
  }
  
  const json = JSON.parse(resText);
  return json.candidates[0].content.parts[0].text;
}

/**
 * Helper to get the spreadsheet database or initialize it.
 */
function getDatabaseSheet() {
  const userProperties = PropertiesService.getUserProperties();
  const spreadsheetId = userProperties.getProperty("SPREADSHEET_ID");
  let ss;
  
  if (spreadsheetId) {
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (e) {
      Logger.log("Stored spreadsheet ID not found or inaccessible. Creating a new one...");
      ss = SpreadsheetApp.create("Email Audit Data");
      userProperties.setProperty("SPREADSHEET_ID", ss.getId());
    }
  } else {
    ss = SpreadsheetApp.create("Email Audit Data");
    userProperties.setProperty("SPREADSHEET_ID", ss.getId());
  }
  
  const sheet = ss.getSheets()[0];
  
  // Set up headers if it is a new/empty sheet
  if (sheet.getLastRow() === 0) {
    const headers = [
      "Message ID", 
      "Thread ID", 
      "Type", 
      "Date", 
      "Sender / Recipient", 
      "Subject", 
      "Snippet / Body", 
      "Attachment Names", 
      "Category", 
      "Summary", 
      "Expected Action", 
      "Reply Required?", 
      "Status", 
      "Matched Reply ID"
    ];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f3f3f3");
    sheet.autoResizeColumns(1, headers.length);
  }
  
  return sheet;
}

/**
 * Loads existing records from the sheet to prevent duplication.
 */
function loadDatabaseRecords(sheet) {
  const lastRow = sheet.getLastRow();
  const records = [];
  const recordsMap = {};
  const pendingNotices = [];
  
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, 14).getValues();
    data.forEach((row, index) => {
      const rowNum = index + 2; // Offset for header (1) and 0-indexing (1)
      const msgId = row[0];
      const type = row[2];
      const sender = row[4];
      const subject = row[5];
      const category = row[8];
      const summary = row[9];
      const status = row[12];
      
      records.push({
        rowNum: rowNum,
        msgId: msgId,
        type: type,
        status: status
      });
      
      recordsMap[msgId] = rowNum;
      
      if (type === "INCOMING" && status === "Pending") {
        pendingNotices.push({
          rowNum: rowNum,
          msgId: msgId,
          sender: sender,
          subject: subject,
          summary: summary
        });
      }
    });
  }
  
  return {
    records: records,
    recordsMap: recordsMap,
    pendingNotices: pendingNotices
  };
}

/**
 * Resets the tracking state so that the auditor runs from scratch.
 * Useful for re-processing or initial setups.
 */
function resetLastProcessedTime() {
  PropertiesService.getUserProperties().deleteProperty("LAST_PROCESSED_TIMESTAMP");
  Logger.log("State reset. Next run will start from 7 days ago.");
}
