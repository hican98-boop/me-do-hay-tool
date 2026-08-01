/**
 * Cloudflare Worker - Shopee Affiliate Link Converter
 * AFF_ID: 17365020085
 *
 * Flow: nhận URL → mở → lấy link sau redirect / parse HTML → convert affiliate
 */

const AFF_ID = "17365020085";

const FULL_DOMAINS = ["shopee.vn", "shopee.com.vn"];
const SHORT_DOMAINS = ["shp.ee", "s.shopee.vn", "vn.shp.ee", "shope.ee"];

function isFullDomain(hostname) {
  const host = (hostname || "").toLowerCase();
  return FULL_DOMAINS.some(d => host === d || host.endsWith("." + d));
}

function isShortDomain(hostname) {
  const host = (hostname || "").toLowerCase();
  return SHORT_DOMAINS.some(d => host === d || host.endsWith("." + d));
}

function isShopeeHost(hostname) {
  return isFullDomain(hostname) || isShortDomain(hostname);
}

function cleanUrl(urlObj) {
  const dirty = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "uls_trackid", "smtt", "sp_atk", "xptdk", "af_siteid", "sub_id",
    "affiliate_id", "aff_sid", "mmp_pid", "d_id"
  ];
  dirty.forEach(p => urlObj.searchParams.delete(p));
  return urlObj;
}

function buildAffiliateLink(originUrl) {
  return `https://s.shopee.vn/an_redir?origin_link=${encodeURIComponent(originUrl)}&affiliate_id=${AFF_ID}`;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * 1) Follow HTTP redirect
 * 2) Nếu vẫn là short link → đọc HTML lấy CONFIG.httpUrl / product URL
 */
async function expandShortLink(shortUrl) {
  let current = shortUrl;

  // --- Bước 1: follow redirect thủ công ---
  for (let i = 0; i < 6; i++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
      }
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) break;
      try {
        current = new URL(loc, current).href;
      } catch {
        current = loc;
      }
      try {
        if (isFullDomain(new URL(current).hostname)) return current;
      } catch (_) {}
      continue;
    }
    break;
  }

  // Thử follow tự động + parse HTML
  try {
    const res2 = await fetch(current, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "vi-VN,vi;q=0.9" }
    });
    if (res2.url && isFullDomain(new URL(res2.url).hostname)) {
      return res2.url;
    }
    current = res2.url || current;

    const html = await res2.text();
    const fromHtml = extractProductUrlFromHtml(html);
    if (fromHtml) return fromHtml;
  } catch (_) {}

  // Parse HTML từ short URL gốc
  try {
    const res3 = await fetch(shortUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "vi-VN,vi;q=0.9" }
    });
    const html = await res3.text();
    const fromHtml = extractProductUrlFromHtml(html);
    if (fromHtml) return fromHtml;
    if (res3.url && isFullDomain(new URL(res3.url).hostname)) return res3.url;
  } catch (_) {}

  return current;
}

function extractProductUrlFromHtml(html) {
  if (!html) return null;

  // 1. CONFIG.httpUrl
  let m = html.match(/httpUrl["']?\s*:\s*["']([^"']+)["']/i);
  if (m && m[1]) {
    const u = decodeHtmlUrl(m[1]);
    if (u && isFullDomain(safeHostname(u))) return u;
  }

  // 2. escaped https:\/\/shopee.vn\/product\/
  m = html.match(/https?:\\\/\\\/shopee\.vn\\\/product\\\/\d+\\\/\d+[^"'\\\s]*/i);
  if (m && m[0]) {
    const u = decodeHtmlUrl(m[0]);
    if (u && isFullDomain(safeHostname(u))) return u;
  }

  // 3. https://shopee.vn/product/ID/ID
  m = html.match(/https?:\/\/shopee\.vn\/product\/\d+\/\d+[^\s"'<>]*/i);
  if (m && m[0]) {
    const u = m[0].replace(/&amp;/g, "&");
    if (isFullDomain(safeHostname(u))) return u;
  }

  // 4. shopee.vn/...-i.SHOP.ITEM
  m = html.match(/https?:\/\/shopee\.vn\/[^"'<>]*-i\.\d+\.\d+[^\s"'<>]*/i);
  if (m && m[0]) {
    const u = m[0].replace(/&amp;/g, "&");
    if (isFullDomain(safeHostname(u))) return u;
  }

  // 5. og:url
  m = html.match(/property=["']og:url["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+property=["']og:url["']/i);
  if (m && m[1] && isFullDomain(safeHostname(m[1]))) {
    return m[1];
  }

  return null;
}

function decodeHtmlUrl(s) {
  return s
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/\\"/g, '"');
}

function safeHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "";
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Chỉ hỗ trợ POST" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });
    }

    try {
      const body = await request.json();
      let raw = (body.url || "").trim();

      if (!raw) {
        return new Response(JSON.stringify({ error: "Thiếu link" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
        });
      }

      if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

      let urlObj;
      try {
        urlObj = new URL(raw);
      } catch {
        return new Response(JSON.stringify({ error: "Link không hợp lệ" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
        });
      }

      if (!isShopeeHost(urlObj.hostname)) {
        return new Response(JSON.stringify({ error: "Đây không phải link Shopee" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
        });
      }

      // Link rút gọn → mở URL → lấy link sau redirect / parse HTML
      if (isShortDomain(urlObj.hostname)) {
        let expanded;
        try {
          expanded = await expandShortLink(raw);
        } catch (e) {
          return new Response(JSON.stringify({
            error: "Không mở được link rút gọn. Hãy dán link đầy đủ (shopee.vn/...)."
          }), {
            status: 422,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
          });
        }

        let expandedObj;
        try {
          expandedObj = new URL(expanded);
        } catch {
          return new Response(JSON.stringify({
            error: "Không lấy được link sản phẩm. Hãy dán link đầy đủ (shopee.vn/...)."
          }), {
            status: 422,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
          });
        }

        if (!isFullDomain(expandedObj.hostname)) {
          return new Response(JSON.stringify({
            error: "Link rút gọn chưa mở rộng được. Hãy mở link trên Shopee → copy link thanh địa chỉ (shopee.vn/...) rồi dán lại."
          }), {
            status: 422,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
          });
        }

        urlObj = expandedObj;
      }

      cleanUrl(urlObj);
      const affiliateLink = buildAffiliateLink(urlObj.toString());

      return new Response(JSON.stringify({
        success: true,
        affiliateLink
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        error: "Lỗi xử lý: " + (err.message || "Không xác định")
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });
    }
  }
};
