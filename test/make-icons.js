/* 生成 PWA 图标 PNG：用无头浏览器渲染 SVG 后按各尺寸截图 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('C:', 'Users', 'Administrator', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));

const OUT = path.join(__dirname, '..', 'icons');

// maskable 图标需留安全边距（内容缩到中心 ~80%），保证被裁成圆形也不丢内容
const JOBS = [
  { size: 192, file: 'icon-192.png', maskable: false },
  { size: 512, file: 'icon-512.png', maskable: false },
  { size: 180, file: 'icon-180.png', maskable: false },
  { size: 512, file: 'icon-maskable.png', maskable: true }
];

const svg = ({ maskable, size }) => {
  const scale = maskable ? 0.72 : 0.88;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFC53D"/>
        <stop offset="100%" stop-color="#F08700"/>
      </linearGradient>
    </defs>
    <rect width="100" height="100" rx="${maskable ? 0 : 22}" fill="url(#g)"/>
    <g transform="translate(50 50) scale(${scale}) translate(-50 -50)">
      <text x="50" y="50" font-size="60" font-weight="700" text-anchor="middle" dominant-baseline="central"
            font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" fill="#FFFFFF">¥</text>
    </g>
  </svg>`;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const job of JOBS) {
    const page = await browser.newPage({
      viewport: { width: job.size, height: job.size },
      deviceScaleFactor: 1
    });
    await page.setContent(
      `<body style="margin:0;width:${job.size}px;height:${job.size}px">${svg({ ...job, size: job.size })}</body>`
    );
    await page.screenshot({ path: path.join(OUT, job.file) });
    await page.close();
    console.log('生成', job.file, job.size + 'px', job.maskable ? '(maskable)' : '');
  }
  await browser.close();
})();