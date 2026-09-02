// GENERATED FILE — DO NOT EDIT.
// Compiled from src/corpus/mask.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Redact credentials/secrets from stored session files.
 *
 * Ported from `scripts/mask_sessions.py`. Scans the session store (envelope JSON, raw artifacts,
 * and sidecars), finds high-confidence credentials — GitHub tokens, AWS keys, OpenAI/Anthropic
 * keys, Google/Slack tokens, JWTs, bearer tokens, and PEM private keys — and replaces each real
 * value with a deterministic FAKE value of the same shape and length. The same secret always maps
 * to the same fake, so an envelope and its raw copy stay consistent.
 *
 * It never masks emails, personal names, or file paths (those are not secrets, and masking them
 * corrupts legitimate content). Already-masked values (containing `MARKER`) are skipped, so
 * re-running is idempotent.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RULES = exports.MARKER = void 0;
exports.detBody = detBody;
exports.makeReplacement = makeReplacement;
exports.redactSecrets = redactSecrets;
exports.iterFiles = iterFiles;
exports.buildSecretMap = buildSecretMap;
exports.applyMasking = applyMasking;
exports.redact = redact;
exports.buildReport = buildReport;
exports.run = run;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Embedded in every fake value so masked data is recognizable and skippable. */
exports.MARKER = 'MASKED';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const B62 = LOWER + UPPER + DIGITS;
const B62_UPPER = UPPER + DIGITS;
const B64URL = `${B62}-_`;
/**
 * Each rule: name, regex, and the group that holds the secret. Order matters only for
 * reporting; masking is value-based and de-duplicated.
 */
exports.RULES = [
    { name: 'pem_private_key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, group: 0 },
    { name: 'github_pat_fine', regex: /\bgithub_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/g, group: 0 },
    { name: 'github_pat_classic', regex: /\bghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, group: 0 },
    { name: 'github_oauth', regex: /\bgh[ousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, group: 0 },
    // `sk-ant-` and `sk-proj-` bodies are base64url, so they contain `_` as well as `-`. Omitting
    // `_` from the class did not merely truncate the match, it lost the key entirely: the run before
    // the first `_` is shorter than the {20,} minimum, so nothing matched at all.
    { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, group: 0 },
    // `(?!ant-)` stops this rule swallowing an Anthropic key now that its class includes `-`.
    // Either rule would mask the value; only this one would mislabel it in the report.
    { name: 'openai_key', regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, group: 0 },
    { name: 'aws_access_key_id', regex: /\bAKIA[0-9A-Z]{16}(?![0-9A-Z])/g, group: 0 },
    { name: 'aws_secret_access_key', regex: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 1 },
    { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, group: 0 },
    { name: 'slack_token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}(?![0-9A-Za-z-])/g, group: 0 },
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g, group: 0 },
    { name: 'bearer_token', regex: /(?:bearer|token)\s+([A-Za-z0-9._-]{20,})/gi, group: 1 },
];
/** Deterministic pseudo-random string of `length` chars drawn from `charset`. */
function detBody(seed, length, charset) {
    const digest = (0, crypto_1.createHash)('sha256').update(seed, 'utf8').digest();
    let out = '';
    let i = 0;
    while (out.length < length) {
        out += charset[digest[i % digest.length] % charset.length];
        i++;
    }
    return out;
}
/** `prefix + MARKER + deterministic body`, exactly `original.length` chars. */
function fill(prefix, original, charset) {
    const bodyLen = original.length - prefix.length;
    if (bodyLen <= 0) {
        return original;
    }
    const body = (exports.MARKER + detBody(original, bodyLen, charset)).slice(0, bodyLen);
    return prefix + body;
}
/** Build a same-shape, same-length fake for a detected secret. */
function makeReplacement(name, secret) {
    switch (name) {
        case 'pem_private_key':
            return '-----BEGIN PRIVATE KEY-----\n'
                + 'MASKEDMASKEDMASKEDMASKEDMASKEDMASKEDMASKEDMASKEDFAKEKEY==\n'
                + '-----END PRIVATE KEY-----';
        case 'github_pat_fine': return fill('github_pat_', secret, B62);
        case 'github_pat_classic': return fill('ghp_', secret, B62);
        case 'github_oauth': return fill(secret.slice(0, 4), secret, B62); // keep gho_/ghu_/ghs_/ghr_
        case 'anthropic_key': return fill('sk-ant-', secret, B64URL);
        case 'openai_key':
            return fill(secret.startsWith('sk-proj-') ? 'sk-proj-' : 'sk-', secret, B64URL);
        case 'aws_access_key_id': return fill('AKIA', secret, B62_UPPER);
        case 'aws_secret_access_key': return fill('', secret, B62);
        case 'google_api_key': return fill('AIza', secret, B64URL);
        case 'slack_token': return fill(secret.slice(0, 5), secret, `${B62}-`);
        case 'jwt':
            return secret.split('.')
                .map((seg, idx) => (exports.MARKER + detBody(secret + String(idx), seg.length, B64URL)).slice(0, seg.length))
                .join('.');
        case 'bearer_token': return fill('', secret, `${B62}._-`);
        default: return fill('', secret, B62);
    }
}
/**
 * Replace every credential-looking run in `text` with `placeholder`.
 *
 * Use this for text that becomes something other than file content — a filename, a slug, a log
 * line — where the shape-preserving fakes are pointless and the value must simply not appear.
 * File content goes through {@link applyMasking} instead, which keeps shape and length.
 */
function redactSecrets(text, placeholder = 'redacted') {
    let out = text;
    for (const rule of exports.RULES) {
        rule.regex.lastIndex = 0;
        out = out.replace(rule.regex, (match, ...groups) => {
            if (rule.group === 0) {
                return placeholder;
            }
            const captured = groups[rule.group - 1];
            return typeof captured === 'string' ? match.replace(captured, placeholder) : placeholder;
        });
    }
    return out;
}
/** Every file under `root`, sorted, recursively. */
async function iterFiles(root) {
    const out = [];
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            }
            else if (entry.isFile()) {
                out.push(full);
            }
        }
    };
    await walk(root);
    return out.sort();
}
/**
 * Scan all files and build the secret → replacement mapping. Values already containing `MARKER`
 * are skipped, which is what makes a re-run idempotent.
 */
async function buildSecretMap(files, repoRoot) {
    const mapping = new Map();
    const meta = new Map();
    const hits = new Map();
    for (const file of files) {
        let text;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        const rel = path.relative(repoRoot, file);
        for (const rule of exports.RULES) {
            rule.regex.lastIndex = 0;
            let m;
            while ((m = rule.regex.exec(text)) !== null) {
                const secret = m[rule.group];
                if (!secret || secret.includes(exports.MARKER)) {
                    continue;
                }
                const perFile = hits.get(secret) ?? new Map();
                perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
                hits.set(secret, perFile);
                if (!mapping.has(secret)) {
                    meta.set(secret, rule.name);
                    mapping.set(secret, makeReplacement(rule.name, secret));
                }
                if (m[0].length === 0) {
                    rule.regex.lastIndex++;
                } // never loop on a zero-width match
            }
        }
    }
    return { mapping, meta, hits };
}
function replaceAll(haystack, needle, replacement) {
    let count = 0;
    let out = '';
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) {
            out += haystack.slice(from);
            break;
        }
        out += haystack.slice(from, at) + replacement;
        from = at + needle.length;
        count++;
    }
    return [out, count];
}
/** Replace every secret in every file. Returns `{ relative file -> replacements applied }`. */
async function applyMasking(files, mapping, repoRoot, dryRun) {
    // Longest secrets first, so a secret that is a substring of another is safe.
    const ordered = [...mapping.keys()].sort((a, b) => b.length - a.length);
    const perFile = {};
    for (const file of files) {
        let text;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        let next = text;
        let applied = 0;
        for (const secret of ordered) {
            if (!next.includes(secret)) {
                continue;
            }
            const [replaced, n] = replaceAll(next, secret, mapping.get(secret));
            next = replaced;
            applied += n;
        }
        if (applied && next !== text) {
            perFile[path.relative(repoRoot, file)] = applied;
            if (!dryRun) {
                await fs.promises.writeFile(file, next, 'utf8');
            }
        }
    }
    return perFile;
}
/** A redacted preview of a secret — never the real value. */
function redact(secret) {
    const s = secret.replace(/\n/g, ' ');
    if (s.length <= 10) {
        return `${s.slice(0, 2)}…`;
    }
    return `${s.slice(0, 4)}…${s.slice(-3)}`;
}
function buildReport(scan, perFile, fileCount, dryRun, now = new Date()) {
    const byType = new Map();
    for (const [secret, name] of scan.meta) {
        byType.set(name, [...(byType.get(name) ?? []), secret]);
    }
    const totalReplacements = Object.values(perFile).reduce((a, b) => a + b, 0);
    const lines = [
        '# Session masking report',
        '',
        `- Generated: ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
        `- Files scanned: ${fileCount}`,
        `- Files modified: ${Object.keys(perFile).length}`,
        `- Unique secrets masked: ${scan.mapping.size}`,
        `- Total replacements: ${totalReplacements}`,
        `- Mode: ${dryRun ? 'DRY-RUN (no files written)' : 'APPLIED'}`,
        '',
        'Real secret values are shown only as redacted previews (`first4…last3`); the repository '
            + 'never stores the originals.',
        '',
        '## Secrets by type',
        '',
    ];
    for (const name of [...byType.keys()].sort()) {
        const secrets = byType.get(name);
        const total = secrets.reduce((sum, s) => sum + [...(scan.hits.get(s)?.values() ?? [])].reduce((a, b) => a + b, 0), 0);
        lines.push(`### ${name} — ${secrets.length} unique, ${total} occurrences`, '');
        lines.push('| # | original (redacted) | length | replacement (redacted) | occurrences | files |');
        lines.push('|---|---|---|---|---|---|');
        secrets.sort().forEach((s, i) => {
            const perFileHits = scan.hits.get(s) ?? new Map();
            const occ = [...perFileHits.values()].reduce((a, b) => a + b, 0);
            lines.push(`| ${i + 1} | \`${redact(s)}\` | ${s.length} | \`${redact(scan.mapping.get(s))}\` `
                + `| ${occ} | ${perFileHits.size} |`);
        });
        lines.push('');
    }
    lines.push('## Files modified', '');
    const modified = Object.keys(perFile).sort();
    if (modified.length) {
        lines.push('| file | replacements |', '|---|---|');
        for (const f of modified) {
            lines.push(`| ${f} | ${perFile[f]} |`);
        }
    }
    else {
        lines.push('_No files modified._');
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}
/**
 * Mask secrets under `data/sessions/<user>` (or the whole store) and write a report.
 * Safe to call from other code — the importer does exactly that before committing.
 */
async function run(opts) {
    const dataRoot = path.join(opts.repoRoot, 'data', 'sessions');
    const base = opts.user ? path.join(dataRoot, opts.user) : dataRoot;
    const files = await iterFiles(base);
    if (files.length === 0) {
        return {
            filesScanned: 0, unique: 0, replacements: 0, filesModified: 0,
            reportPath: null, content: '',
        };
    }
    const dryRun = opts.dryRun === true;
    const scan = await buildSecretMap(files, opts.repoRoot);
    const perFile = await applyMasking(files, scan.mapping, opts.repoRoot, dryRun);
    const reportPath = opts.reportPath
        ?? path.join(opts.user ? path.join(dataRoot, opts.user) : dataRoot, 'MASKING-REPORT.md');
    const content = buildReport(scan, perFile, files.length, dryRun);
    if (!dryRun) {
        await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
        await fs.promises.writeFile(reportPath, content, 'utf8');
    }
    return {
        filesScanned: files.length,
        unique: scan.mapping.size,
        replacements: Object.values(perFile).reduce((a, b) => a + b, 0),
        filesModified: Object.keys(perFile).length,
        reportPath,
        content,
    };
}
