/**
 * dsh-plugins-path-viewer —— 用同源网页查看器替代 GUI 的原生路径打开。
 *
 * WSL 场景下原生打开要 spawn powershell.exe(appendWindowsPath=false 时 ENOENT),
 * 且"从 WSL 唤起 Windows 桌面"本就别扭。GUI 本身就跑在 Windows 浏览器里,所以:
 *
 *  1. 向 webServer 注册 GET /view?path=<绝对路径>[&line=N]:
 *     文件 → 行号表格页;目录 → 列表页。回环围栏 + 大小上限 + 二进制识别。
 *  2. 通过 `webserver/index-inject` 往页面注一段 head 脚本:拦截发往
 *     /api/host.openPath|host.openTextFile 的 RPC,改为 window.open('/view?…'),
 *     并按线上封包形状伪造成功应答({type:'server-response',rpcId,result:{ok,value}}),
 *     弹窗被拦截时自动放行原始请求。
 *
 * 纯服务端插件,仅依赖 highlight.js;不改动 harness 仓库。
 */

import { open, readdir, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import css from 'highlight.js/lib/languages/css'
import cpp from 'highlight.js/lib/languages/cpp'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('css', css)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const HARD_MAX_BYTES = 16 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const LANGUAGE_BY_EXTENSION = new Map([
  ['.c', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.css', 'css'], ['.go', 'go'],
  ['.html', 'xml'], ['.htm', 'xml'], ['.java', 'java'], ['.js', 'javascript'],
  ['.json', 'json'], ['.jsx', 'javascript'], ['.md', 'markdown'], ['.mjs', 'javascript'],
  ['.py', 'python'], ['.rs', 'rust'], ['.sh', 'bash'], ['.sql', 'sql'], ['.ts', 'typescript'],
  ['.tsx', 'typescript'], ['.xml', 'xml'], ['.yaml', 'yaml'], ['.yml', 'yaml'],
])
const LANGUAGE_BY_NAME = new Map([
  ['Dockerfile', 'dockerfile'], ['Makefile', 'bash'],
])

/* ---------------- 小工具 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&#34;' : '&#39;'
  ))
}

function highlightCode(source, absPath) {
  const language = LANGUAGE_BY_NAME.get(nodePath.basename(absPath))
    ?? LANGUAGE_BY_EXTENSION.get(nodePath.extname(absPath).toLowerCase())
  if (language === undefined) return escapeHtml(source)
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value
  } catch {
    // A malformed source file should still be viewable as safely escaped text.
    return escapeHtml(source)
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function isLoopbackHost(host) {
  const bare = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost'
}

function page(title, body, extraHead) {
  return [
    '<!doctype html><html lang="zh-CN"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark;--bg:#f4f6fb;--surface:#fff;--surface-2:#f8f9fc;--text:#182033;--muted:#69738a;--line:#dce1eb;--accent:#2563eb;--accent-soft:#e8f0ff;--hover:#f1f5ff;--warning:#9a5b00;--warning-bg:#fff8e8}',
    '@media(prefers-color-scheme:dark){:root{--bg:#10131a;--surface:#171b24;--surface-2:#1c2230;--text:#e8ecf5;--muted:#9ba7bc;--line:#2d3545;--accent:#8ab4ff;--accent-soft:#1b335b;--hover:#1c2c47;--warning:#ffc464;--warning-bg:#332911}}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:24px;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--text)}',
    '.shell{max-width:1600px;min-height:calc(100vh - 48px);margin:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 18px 60px color-mix(in srgb,var(--text) 12%,transparent)}',
    '.bar{position:sticky;top:0;display:flex;gap:1.25em;align-items:center;justify-content:space-between;padding:13px 18px;background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);z-index:2}',
    '.identity{min-width:0}.kicker{color:var(--accent);font-size:10px;font-weight:800;letter-spacing:.12em}.bar .p{font-weight:650;word-break:break-all}.meta{display:flex;gap:.75em;align-items:center;color:var(--muted);font-size:12px;white-space:nowrap}',
    '.button{display:inline-flex;align-items:center;padding:.35em .65em;border:1px solid var(--line);border-radius:5px;color:var(--text);background:var(--surface-2);font-size:12px;text-decoration:none}.button:hover{background:var(--hover);border-color:var(--accent);text-decoration:none}',
    '.wrap{padding:14px 18px 36px;overflow:auto}',
    'table{border-collapse:separate;border-spacing:0;width:100%}td{vertical-align:top;padding:0}',
    'tr{transition:background .12s ease}tr:hover{background:var(--hover)}',
    'td.ln{text-align:right;user-select:none;width:1%;min-width:4.5em;border-right:1px solid var(--line);background:var(--surface-2);position:sticky;left:0;z-index:1}',
    'td.ln a{display:block;padding:0 13px;color:var(--muted);text-decoration:none}td.ln a:hover{color:var(--accent);background:var(--accent-soft)}',
    'tr.hl{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}tr.hl td.ln{background:var(--accent-soft)}',
    'td.cl{padding:0 16px;white-space:pre-wrap;word-break:break-all;tab-size:4}',
    '.hljs-comment,.hljs-quote{color:#7b8496;font-style:italic}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#9b36a5}.hljs-string,.hljs-regexp,.hljs-addition{color:#087f5b}.hljs-number,.hljs-built_in{color:#b45309}.hljs-title,.hljs-title.function_,.hljs-section{color:#145dcc}.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#a33b14}.hljs-meta,.hljs-symbol{color:#7c3aed}.hljs-deletion{color:#b42318}',
    '@media(prefers-color-scheme:dark){.hljs-comment,.hljs-quote{color:#7f8ca3}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#d39be0}.hljs-string,.hljs-regexp,.hljs-addition{color:#7ee2b8}.hljs-number,.hljs-built_in{color:#f4b860}.hljs-title,.hljs-title.function_,.hljs-section{color:#8ab4ff}.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#ffad85}.hljs-meta,.hljs-symbol{color:#c6a0f6}.hljs-deletion{color:#ff8e8e}}',
    'a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}',
    '.directory{list-style:none;padding:0;margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}.directory li{display:grid;grid-template-columns:minmax(0,1fr) 105px 172px;gap:14px;align-items:center;padding:9px 12px;border-top:1px solid var(--line);word-break:break-all}.directory li:first-child{border-top:0}.directory li:hover{background:var(--hover)}',
    '.entry-name{min-width:0}.badge{display:inline-block;min-width:38px;margin-right:9px;padding:1px 4px;border:1px solid var(--line);border-radius:3px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.04em;text-align:center}.dir .badge{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,var(--line))}.sz{color:var(--muted);font-size:12px;text-align:right}.list-head{display:grid;grid-template-columns:minmax(0,1fr) 105px 172px;gap:14px;padding:0 12px 7px;color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}',
    '.banner{margin:0 0 14px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--warning) 55%,var(--line));border-radius:7px;color:var(--warning);background:var(--warning-bg)}',
    '@media(max-width:680px){body{padding:0}.shell{min-height:100vh;border:0;border-radius:0}.bar{align-items:flex-start;padding:12px;gap:.75em}.meta{align-items:flex-end;flex-direction:column;gap:.35em}.meta .details{display:none}.wrap{padding:10px 12px 24px}td.ln{min-width:3.6em}td.ln a{padding:0 9px}td.cl{padding:0 10px}.directory li{grid-template-columns:minmax(0,1fr) auto;gap:8px}.directory li .mtime,.list-head .mtime{display:none}.list-head{grid-template-columns:minmax(0,1fr) auto;gap:8px}.badge{min-width:34px;margin-right:5px;font-size:9px}}',
    '</style>',
    extraHead || '',
    '</head><body>',
    '<main class="shell">', body, '</main>',
    '</body></html>',
  ].join('')
}

function viewerBar(kind, absPath, meta, action) {
  return [
    '<header class="bar"><div class="identity">',
    `<div class="kicker">${kind}</div><div class="p">${escapeHtml(absPath)}</div></div>`,
    `<div class="meta"><span class="details">${escapeHtml(meta)}</span>${action || ''}</div></header>`,
  ].join('')
}

/* ---------------- 文件 / 目录渲染 ---------------- */

async function readCapped(absPath, maxBytes, fsf) {
  const handle = await fsf.open(absPath, 'r')
  try {
    const chunks = []
    let total = 0
    let truncated = false
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const want = Math.min(buf.length, maxBytes + 1 - total)
      if (want <= 0) { truncated = total > maxBytes; break }
      const { bytesRead } = await handle.read(buf, 0, want, total)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)))
      total += bytesRead
      if (total > maxBytes) { truncated = true; break }
    }
    return { buffer: Buffer.concat(chunks), truncated }
  } finally {
    await handle.close()
  }
}

function looksBinary(buffer) {
  const n = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < n; i++) {
    const b = buffer[i]
    if (b === 0) return true
    if ((b < 9 || (b > 13 && b < 32 && b !== 27)) && i > 64) return true
  }
  return false
}

async function renderFile(absPath, info, lineNo, cfg, fsf) {
  const { buffer, truncated } = await readCapped(absPath, cfg.maxBytes, fsf)

  if (looksBinary(buffer)) {
    const body = [
      viewerBar('BINARY FILE', absPath, `${fmtBytes(info.size)} · 二进制文件，不渲染内容`),
      '<div class="wrap"><div class="banner">该文件看起来是二进制(含 NUL/控制字符),此查看器只展示文本。</div></div>',
    ].join('')
    return page(`${absPath}`, body)
  }

  const rows = buffer.toString('utf8').split(/\r?\n/)
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()

  const cells = rows.map((content, i) => {
    const n = i + 1
    const cls = lineNo === n ? ' class="hl"' : ''
    return `<tr${cls} id="L${n}"><td class="ln"><a href="#L${n}">${n}</a></td>`
      + `<td class="cl">${highlightCode(content, absPath)}</td></tr>`
  }).join('')

  const banners = []
  if (truncated) banners.push(`<div class="banner">文件大于 ${fmtBytes(cfg.maxBytes)},仅显示前 ${fmtBytes(buffer.length)}。</div>`)
  if (info.size > HARD_MAX_BYTES) banners.push(`<div class="banner">完整大小 ${fmtBytes(info.size)},超出硬上限。</div>`)

  const meta = `${info.size} 字节 · ${rows.length} 行 · 修改于 ${fmtTime(info.mtimeMs)}`
  const jump = Number(lineNo) > 0 && Number(lineNo) <= rows.length ? Number(lineNo) : 0
  const script = '<script>addEventListener("load",function(){var n=' + jump
    + ';if(!n)return;var el=document.getElementById("L"+n);'
    + 'if(el)el.scrollIntoView({block:"center"});});</script>'
  const body = [
    viewerBar('SOURCE FILE', absPath, meta, `<a class="button" href="/view?path=${encodeURIComponent(absPath)}">Reload</a>`),
    `<div class="wrap">${banners.join('')}<table><tbody>${cells}</tbody></table></div>`,
  ].join('')
  return page(absPath, body, script)
}

async function renderDir(absPath, info, pathmod, fsf) {
  const dirents = await fsf.readdir(absPath, { withFileTypes: true })
  const items = await Promise.all(dirents.map(async d => {
    const full = pathmod.join(absPath, d.name)
    let size = ''
    let mtime = ''
    try {
      const st = await fsf.stat(full)
      size = d.isDirectory() ? '<dir>' : fmtBytes(st.size)
      mtime = fmtTime(st.mtimeMs)
    } catch { size = '?' }
    return {
      href: `/view?path=${encodeURIComponent(full)}`,
      label: d.name + (d.isDirectory() ? '/' : ''),
      size,
      mtime,
      dir: d.isDirectory(),
    }
  }))
  items.sort((a, b) => (b.dir - a.dir) || a.label.localeCompare(b.label, 'zh-CN'))

  const parent = pathmod.resolve(absPath, '..')
  const lis = items.map(it =>
    `<li class="${it.dir ? 'dir' : ''}"><span class="entry-name"><span class="badge">${it.dir ? 'DIR' : 'FILE'}</span>`
    + `<a href="${escapeHtml(it.href)}"${it.dir ? '' : ' target="_blank" rel="opener"'}>${escapeHtml(it.label)}</a></span>`
    + `<span class="sz">${escapeHtml(it.size)}</span><span class="sz mtime">${escapeHtml(it.mtime)}</span></li>`,
  ).join('')
  const meta = `${items.length} 项 · 修改于 ${fmtTime(info.mtimeMs)}`
  const body = [
    viewerBar('DIRECTORY', absPath, meta),
    '<div class="wrap"><div class="list-head"><span>Name</span><span>Size</span><span class="mtime">Modified</span></div>',
    `<ul class="directory"><li class="dir"><span class="entry-name"><span class="badge">UP</span><a href="/view?path=${encodeURIComponent(parent)}">..</a></span><span class="sz"></span><span class="sz mtime"></span></li>${lis}</ul></div>`,
  ].join('')
  return page(absPath, body)
}

/* ---------------- 注入脚本:点击路径 → /view ---------------- */

function interceptionScript(methods) {
  const methodRe = methods.map(m => m.replace(/\./g, '\\.')).join('|')
  // 经典脚本、无模板串;window.open 失败(popover 拦截)则放行原请求。
  return [
    '(function(){',
    'if(window.__dshPathViewer)return;window.__dshPathViewer=true;',
    'var orig=window.fetch;',
    'if(typeof orig!=="function")return;',
    'var re=new RegExp("/api/(" + "' + methodRe + '" + ")$");',
    'window.fetch=function(input,init){',
    'try{',
    'var url=typeof input==="string"?input:(input&&typeof input.href==="string"?input.href:(input&&input.url)||"");',
    'if(init&&init.method==="POST"&&re.test(url)&&typeof init.body==="string"){',
    'var msg=JSON.parse(init.body);',
    'var p=msg&&msg.payload&&msg.payload.path;',
    'if(typeof p==="string"&&p.length>0){',
    'var w=window.open("/view?path="+encodeURIComponent(p),"_blank");',
    'if(w){return Promise.resolve(new Response(JSON.stringify({',
    'type:"server-response",rpcId:msg.rpcId,',
    'result:{ok:true,value:{opened:true}}',
    '}),{status:200,headers:{"content-type":"application/json"}}));}',
    '}',
    '}',
    '}catch(e){}',
    'return orig.apply(this,arguments);',
    '};',
    '})();',
  ].join('\n')
}

/* ---------------- 插件入口 ---------------- */

export const name = 'dsh-plugins-path-viewer'

/** 路由挂在 webServer 上;缺该服务的 profile(headless)不装本插件。 */
export const inject = ['webServer']

export function apply(ctx, config) {
  const cfg = {
    maxBytes: typeof config?.maxBytes === 'number' && config.maxBytes > 0
      ? Math.min(config.maxBytes, HARD_MAX_BYTES)
      : DEFAULT_MAX_BYTES,
    /** 拦截并改道的 RPC 方法名列表。 */
    intercept: Array.isArray(config?.intercept) && config.intercept.length > 0
      ? config.intercept.filter(m => typeof m === 'string')
      : ['host.openPath', 'host.openTextFile'],
  }
  const pathmod = nodePath
  const fsf = { open, readdir, stat }

  // 1) /view 路由(文件行号页 / 目录列表页)。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/view',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url ?? '/view', `http://${req.headers.host ?? '127.0.0.1'}`)
        if (!isLoopbackHost(req.headers.host)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        const rawPath = u.searchParams.get('path')
        if (!rawPath || !rawPath.startsWith(pathmod.sep) || rawPath.includes('\0')) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad request: 需要绝对的 ?path=')
          return
        }
        const absPath = pathmod.resolve(rawPath)
        const lineNo = Number(u.searchParams.get('line')) || undefined
        let info
        try {
          info = await fsf.stat(absPath)
        } catch {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
          res.end(page('not found', `<div class="wrap"><div class="banner">路径不存在:${escapeHtml(absPath)}</div></div>`))
          return
        }
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('cache-control', 'no-store')
        if (info.isDirectory()) res.end(await renderDir(absPath, info, pathmod, fsf))
        else if (info.isFile()) res.end(await renderFile(absPath, info, lineNo, cfg, fsf))
        else {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          res.end(page('unsupported', '<div class="wrap"><div class="banner">既不是常规文件也不是目录</div></div>'))
        }
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`path-viewer error: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }), 'dsh-plugins-path-viewer: /view route')

  // 2) 页面注入:点击路径改开 /view 新标签页(webserver 每次 index 渲染都会 emit)。
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'script', placement: 'head', text: interceptionScript(cfg.intercept) })
  })
}

/** 仅供测试的内部件。 */
export const _internals = { escapeHtml, page, renderFile, renderDir, looksBinary, interceptionScript, isLoopbackHost, highlightCode }
