fetch('https://quickchart.io/web/html-to-image', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ html: '<div style="background: red; width: 100px; height: 100px; color: white;">Test</div>' })
})
  .then(r => r.arrayBuffer())
  .then(b => console.log('Downloaded POST', b.byteLength, 'bytes'))
  .catch(console.error);
