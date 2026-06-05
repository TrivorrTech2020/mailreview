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

console.log("Downloading spreadsheet via Drive API export...");

const url = `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}/export?mimeType=text/csv`;

const options = {
  headers: {
    'Authorization': `Bearer ${token.access_token}`
  }
};

const req = https.get(url, options, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to export file. Status code: ${res.statusCode}`);
    let body = "";
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.error("Response: " + body);
    });
    return;
  }

  const fileStream = fs.createWriteStream(OUTPUT_FILE);
  res.pipe(fileStream);

  fileStream.on('finish', () => {
    fileStream.close();
    console.log("Successfully downloaded spreadsheet CSV to: " + OUTPUT_FILE);
  });
});

req.on('error', (e) => {
  console.error("HTTP request error: " + e.message);
});
