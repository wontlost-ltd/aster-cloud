import { describe, expect, it } from 'vitest';
import { isBotUserAgent } from '@/lib/product-events/bot-filter';

describe('isBotUserAgent', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/126.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 Chrome-Lighthouse',
    'facebookexternalhit/1.1',
    'Slackbot-LinkExpanding 1.0',
    'LinkedInBot/1.0',
    'curl/8.4.0',
    'python-requests/2.31',
    '',
    null,
  ])('机器：%s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  ])('真人浏览器：%s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });
});
