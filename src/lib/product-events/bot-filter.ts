/**
 * 常见爬虫 / 链接预览 / 自动化客户端的 User-Agent 识别，用于不把它们的落地页访问计入需求指标。
 *
 * 只匹配**抓取器**自己的 UA（Slackbot、TelegramBot、Discordbot、WhatsApp 预览、SkypeUriPreview、
 * facebookexternalhit、Twitterbot、LinkedInBot 等），不匹配这些应用的**内置浏览器**：分享渠道正是
 * Slack / Telegram / WhatsApp / LinkedIn 等，用户在应用内点开链接是真实访问，不能丢。
 * 只是粗筛（UA 可伪造），管理端把访问量标为「方向性」上界；缺 UA 的请求按机器处理。
 */
const BOT_UA_RE = new RegExp(
  [
    // 通用爬虫标记：Googlebot、bingbot、Slackbot-LinkExpanding、TelegramBot、Discordbot、Twitterbot、LinkedInBot…
    // 用 bot 后接非字母，避免误伤恰好含 "bot" 子串的普通 UA。
    'bot(?![a-z])',
    'crawl', 'spider', 'slurp', 'scrapy',
    // 链接预览抓取器（各自的专用 UA，与应用内浏览器不同）
    '^whatsapp/', 'skypeuripreview', 'facebookexternalhit', 'facebookcatalog', 'slack-imgproxy', 'embedly',
    'vkshare', 'pinterest/', 'redditbot', 'applebot',
    // 性能 / 可用性探测
    'headlesschrome', 'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
    // 脚本与自动化客户端
    '^curl/', '^wget/', 'python-requests', 'python-urllib', 'aiohttp', 'httpx', 'okhttp', 'axios/', 'node-fetch',
    'undici', 'go-http-client', '^java/', 'apache-httpclient', 'libwww', 'phantomjs', 'selenium', 'playwright',
    'puppeteer',
  ].join('|'),
  'i',
);

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_UA_RE.test(userAgent.trim());
}
