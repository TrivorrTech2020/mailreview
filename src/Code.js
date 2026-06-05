/**
 * Fetches the last 100 incoming emails, filters out promotions and social media,
 * and exports them to a Google Sheet for category analysis.
 */
function exportEmailsToSheet() {
  Logger.log("Starting email export...");
  
  // Search query to get inbox emails, excluding promotions and social categories
  const query = "in:inbox -category:promotions -category:social";
  const threads = GmailApp.search(query, 0, 100);
  Logger.log("Found " + threads.length + " threads matching query.");
  
  const emailData = [];
  const socialDomains = [
    "linkedin.com",
    "facebookmail.com",
    "instagram.com",
    "twitter.com",
    "t.co",
    "pinterest.com"
  ];
  
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    if (messages.length === 0) continue;
    
    // Get the latest message in the thread
    const latestMessage = messages[messages.length - 1];
    const sender = latestMessage.getFrom();
    const subject = latestMessage.getSubject();
    const date = latestMessage.getDate();
    const snippet = latestMessage.getPlainBody().substring(0, 300);
    
    // Check if the sender is from a social domain
    let isSocial = false;
    for (let j = 0; j < socialDomains.length; j++) {
      if (sender.toLowerCase().indexOf(socialDomains[j]) !== -1) {
        isSocial = true;
        break;
      }
    }
    
    if (isSocial) {
      continue;
    }
    
    // Extract attachment names
    const attachments = latestMessage.getAttachments();
    const attachmentNames = attachments.map(function(att) {
      return att.getName();
    }).join(", ");
    
    emailData.push([
      date,
      sender,
      subject,
      snippet,
      attachmentNames
    ]);
  }
  
  Logger.log("Filtered down to " + emailData.length + " non-social/non-promotional emails.");
  
  // Create or open the spreadsheet
  const sheetName = "Email Audit Data";
  let ss;
  const files = DriveApp.getFilesByName(sheetName);
  
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(sheetName);
  }
  
  const sheet = ss.getSheets()[0];
  sheet.clear();
  
  // Set headers
  sheet.appendRow(["Date", "Sender", "Subject", "Snippet", "Attachments"]);
  
  if (emailData.length > 0) {
    sheet.getRange(2, 1, emailData.length, 5).setValues(emailData);
  }
  
  // Format the sheet
  sheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#f3f3f3");
  sheet.autoResizeColumns(1, 5);
  
  const url = ss.getUrl();
  Logger.log("Emails exported successfully. Google Sheet URL: " + url);
  return url;
}
