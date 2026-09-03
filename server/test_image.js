import puppeteer from 'puppeteer';
import fs from 'fs';

async function generateLeaderboardImageBuffer(report) {
  const ranks = report.rankings || [];
  
  // Format the month nicely
  const [yearStr, monthStr] = report.monthKey.split('-');
  const date = new Date(yearStr, monthStr - 1);
  const monthName = date.toLocaleString('default', { month: 'long', year: 'numeric' });

  // Generate rows
  const rowsHtml = ranks.map(r => {
    let medal = '';
    if (r.rank === 1) medal = '🥇';
    else if (r.rank === 2) medal = '🥈';
    else if (r.rank === 3) medal = '🥉';
    else medal = `<span style="font-size: 0.8em; color: #8b949e;">#${r.rank}</span>`;

    return `
      <div class="row ${r.rank <= 3 ? 'top3' : ''}">
        <div class="rank">${medal}</div>
        <div class="details">
          <div class="name-score">
            <span class="name">${r.member}</span>
            <span class="score">${r.score} <small>/10</small></span>
          </div>
          <div class="one-liner">${r.oneLiner}</div>
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
        body {
          margin: 0;
          padding: 40px;
          background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
          font-family: 'Inter', sans-serif;
          color: #c9d1d9;
          width: 800px;
        }
        .container {
          background: rgba(22, 27, 34, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(10px);
        }
        .header {
          text-align: center;
          margin-bottom: 40px;
        }
        h1 {
          color: #fff;
          font-weight: 800;
          font-size: 32px;
          margin: 0 0 10px 0;
          background: -webkit-linear-gradient(45deg, #58a6ff, #3fb950);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .subtitle {
          color: #8b949e;
          font-size: 18px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 2px;
        }
        .row {
          display: flex;
          align-items: center;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .row.top3 {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .rank {
          font-size: 32px;
          width: 60px;
          text-align: center;
        }
        .details {
          flex: 1;
          margin-left: 20px;
        }
        .name-score {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .name {
          font-size: 22px;
          font-weight: 600;
          color: #fff;
        }
        .score {
          font-size: 22px;
          font-weight: 800;
          color: #3fb950;
        }
        .score small {
          font-size: 14px;
          color: #8b949e;
        }
        .one-liner {
          color: #8b949e;
          font-size: 15px;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Monthly Ranking Report</h1>
          <div class="subtitle">${monthName}</div>
        </div>
        ${rowsHtml}
      </div>
    </body>
    </html>
  `;

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 880, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();
    const buffer = await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: 880,
        height: Math.ceil(boundingBox.height)
      }
    });
    
    await bodyHandle.dispose();
    return Buffer.from(buffer);
  } finally {
    if (browser) await browser.close();
  }
}

async function test() {
  const fakeReport = {
    monthKey: '2026-09',
    rankings: [
      { rank: 1, member: 'Adil', score: 9.5, oneLiner: 'Consistently raised specific UI improvement suggestions and reported critical issues.' },
      { rank: 2, member: 'Habiba', score: 8.8, oneLiner: 'Great testing coverage, though missed one review due to demo.' },
      { rank: 3, member: 'Mohsin', score: 7.5, oneLiner: 'Regularly provided solid suggestions but had 2 half-days.' },
      { rank: 4, member: 'Faz', score: 6.0, oneLiner: 'Sent empty reviews frequently ("No issues identified") and missed 1 day.' }
    ]
  };
  
  const buffer = await generateLeaderboardImageBuffer(fakeReport);
  fs.writeFileSync('test_leaderboard.png', buffer);
  console.log('Saved test_leaderboard.png');
}

test().catch(console.error).finally(() => process.exit(0));
