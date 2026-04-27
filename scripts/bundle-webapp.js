const fs = require('fs');
const path = require('path');

const ROOT = 'F:\\';
const OUTPUTS = [
  'F:\\WE CFM Orchestrator WebApp.html',
  'F:\\desktop-build\\WE CFM Orchestrator WebApp.html',
];

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function escScript(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

const indexHtml = read('index.html');
const styles = read('styles.css');
const dataJs = read('data.js');
const cfmJs = read('cfm-engine.js');
const predictionsJs = read('predictions.js');
const appJs = read('app.js');
const iconSvg = read('pwa-icon.svg');

const bodyMatch = indexHtml.match(/<body>([\s\S]*?)<script src="data\.js"><\/script>/i);
if (!bodyMatch) {
  throw new Error('Could not extract body markup from index.html');
}

const bodyMarkup = bodyMatch[1].trimEnd();
const iconData = `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}`;

const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WE CFM Orchestrator WebApp</title>
  <meta name="description" content="Live CFM benchmark orchestration and predictive UP/DOWN market engine.">
  <meta name="theme-color" content="#0b1020">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="WE CFM">
  <link rel="icon" href="${iconData}">
  <link rel="apple-touch-icon" href="${iconData}">
  <link rel="preconnect" href="https://api.fontshare.com">
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="preconnect" href="https://unpkg.com" crossorigin>
  <link rel="preconnect" href="https://api.crypto.com">
  <link rel="preconnect" href="https://api.coinbase.com">
  <link rel="preconnect" href="https://api.coingecko.com">
  <link rel="preconnect" href="https://api.dexscreener.com">
  <link rel="dns-prefetch" href="https://fapi.binance.com">
  <link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&f[]=jetbrains-mono@400,500&display=swap" rel="stylesheet">
  <script defer src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <script defer src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
  <style>
${styles}
  </style>
</head>
<body>
${bodyMarkup}
<script>
${escScript(dataJs)}
</script>
<script>
${escScript(cfmJs)}
</script>
<script>
${escScript(predictionsJs)}
</script>
<script>
${escScript(appJs)}
</script>
</body>
</html>
`;

for (const output of OUTPUTS) {
  fs.writeFileSync(output, html, 'utf8');
  console.log(`Created: ${output}`);
}
