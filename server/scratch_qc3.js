fetch('https://quickchart.io/web/html-to-image?width=400&height=200&html=<h1>Test</h1>')
  .then(r => r.text())
  .then(t => console.log('Response:', t))
  .catch(console.error);
