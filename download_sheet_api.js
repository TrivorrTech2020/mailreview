const fs = require('fs');
const path = require('path');
const https = require('https');

const SPREADSHEET_ID = "1xoKDzbFlaQnh4ktL5Spx0XW_qVYT3DWf_BzoJizXCwo";
const OUTPUT_FILE = path.join(__dirname, "emails.csv");

// Find clasp credentials
const homeDir = process.env.USERPROFILE || process.env.HOME || "";
const claspRcPath = path.join(homeDir, ".clasprc.json");

if (!fs.existsSync(claspRcPath)) {
  console.error("Could not find .clasprc.json at: " + claspRcPath);
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(claspRcPath, 'utf8'));
const token = creds.tokens && creds.tokens.default;

if (!token || !token.access_token) {
  console.error("No access token found in .clasprc.json");
  process.exit(1);
}

console.log("Fetching spreadsheet metadata from Sheets API...");

function makeRequest(url, callback) {
  const options = {
    headers: {
      'Authorization': `Bearer ${token.access_token}`
    }
  };

  https.get(url, options, (res) => {
    let body = "";
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        callback(new Error(`API returned status ${res.statusCode}: ${body}`));
      } else {
        callback(null, JSON.parse(body));
      }
    });
  }).on('error', (e) => {
    callback(e);
  });
}

// 1. Get sheets metadata
const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
makeRequest(metaUrl, (err, meta) => {
  if (err) {
    console.error("Error fetching metadata:", err.message);
    process.exit(1);
  }

  const firstSheetName = meta.sheets && meta.sheets[0] && meta.sheets[0].properties && meta.sheets[0].properties.title;
  if (!firstSheetName) {
    console.error("No sheets found in spreadsheet.");
    process.exit(1);
  }

  console.log(`First sheet title: "${firstSheetName}". Fetching values...`);

  // 2. Fetch sheet values
  const encodedTitle = encodeURIComponent(firstSheetName);
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodedTitle}`;
  makeRequest(valuesUrl, (err, data) => {
    if (err) {
      console.error("Error fetching sheet values:", err.message);
      process.exit(1);
    }

    const rows = data.values;
    if (!rows || rows.length === 0) {
      console.log("No values found in sheet.");
      process.exit(0);
    }

    // Convert rows to CSV format
    const csvContent = rows.map(row => {
      return row.map(value => {
        // Escape quotes and wrap in quotes
        const valStr = (value || "").toString();
        const escaped = valStr.replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(",");
    }).join("\n");

    fs.writeFileSync(OUTPUT_FILE, csvContent, 'utf8');
    console.log(`Successfully downloaded ${rows.length} rows to ${OUTPUT_FILE}`);
  });
});
