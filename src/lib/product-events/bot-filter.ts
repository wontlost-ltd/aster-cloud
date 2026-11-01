/**
 * 常见爬虫 / 预览 / 自动化客户端的 User-Agent 识别，用于不把它们的落地页访问计入需求指标。
 *
 * 只是粗筛（UA 可伪造），所以管理端把访问量标为「方向性」上界；缺 UA 的请求也按机器处理。
 */
const BOT_UA_RE =
  /bot\b|bot\/|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|skype|curl\/|wget|python-|httpclient|okhttp|axios|node-fetch|undici|go-http-client|java\/|libwww|phantomjs|selenium|playwright|puppeteer/i;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_UA_RE.test(userAgent);
}
