// Runtime configuration, read once from environment variables.
const isProd = process.env.NODE_ENV === 'production';

const code = (v, fallback) => (/^[A-Za-z]{3}$/.test(v || '') ? v.toUpperCase() : fallback);

module.exports = {
  isProd,
  // Currency new schools start with (each school can change it in School settings).
  DEFAULT_CURRENCY: code(process.env.DEFAULT_CURRENCY, 'XAF'),
  // Currency School Unity charges schools in for subscription plans.
  PLATFORM_CURRENCY: code(process.env.PLATFORM_CURRENCY, 'XAF'),
  // Public address of the site, used for payment return/webhook URLs, e.g. https://schoolunity.onrender.com
  // On Render, RENDER_EXTERNAL_URL is set automatically.
  PUBLIC_URL: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  notchpay: {
    // Public key from https://business.notchpay.co (Settings → API keys). Use the sandbox key to test.
    publicKey: process.env.NOTCHPAY_PUBLIC_KEY || '',
    apiBase: (process.env.NOTCHPAY_API_BASE || 'https://api.notchpay.co').replace(/\/+$/, ''),
  },
};
