export function notificationTemplate(title, message, url, ctaLabel) {
  const escapedTitle = String(title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedMessage = String(message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  const hasUrl = typeof url === 'string' && url.length > 0;
  const safeCta = (ctaLabel && String(ctaLabel)) || 'Ver';

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; background:#f5f7fb; margin:0; padding:20px; }
      .card { max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 10px rgba(16,24,40,0.08); }
      .header { background:linear-gradient(90deg,#4f46e5,#06b6d4); color:white; padding:18px 24px; }
      .header h1 { margin:0; font-size:18px; }
      .content { padding:20px 24px; color:#0f172a; }
      .footer { padding:14px 24px; font-size:13px; color:#64748b; background:#f8fafc; }
      .btn { display:inline-block; background:#4f46e5; color:#fff; padding:10px 14px; border-radius:6px; text-decoration:none; }
      .muted { color:#475569; font-size:14px; }
      .center { text-align:center; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <h1>${escapedTitle}</h1>
      </div>
      <div class="content">
        <p class="muted">${escapedMessage}</p>
        ${hasUrl ? `<p class="center" style="margin-top:18px;"><a href="${url}" class="btn" target="_blank" rel="noreferrer noopener">${safeCta}</a></p>` : ''}
      </div>
      <div class="footer">
        <div>UG Emprende — Te notificamos sobre novedades importantes.</div>
      </div>
    </div>
  </body>
  </html>
  `;
}

export default notificationTemplate;
