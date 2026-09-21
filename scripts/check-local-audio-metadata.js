#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { normalizeMetadataText } = require('../desktop/local-music-library');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus']);
const UTF8_MOJIBAKE_MARKERS = /[ÃÂÐÑ]/;
const GBK_MOJIBAKE_MARKERS = /[ÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß²³»¼½¾¿±]/;
const REPLACEMENT_MARKERS = /\uFFFD/;

function usage() {
  console.error('用法: node scripts/check-local-audio-metadata.js <音频目录或文件> [--all] [--output <报告文件>]');
}

function parseArgs(args) {
  const options = { all: false, output: '' };
  const roots = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--all') {
      options.all = true;
    } else if (value === '--output') {
      options.output = String(args[++index] || '');
    } else if (value === '--help' || value === '-h') {
      usage();
      process.exit(0);
    } else {
      roots.push(value);
    }
  }
  return { options, roots };
}

async function collectAudioFiles(root) {
  const stat = await fs.promises.stat(root);
  if (stat.isFile()) {
    return AUDIO_EXTENSIONS.has(path.extname(root).toLowerCase()) ? [root] : [];
  }
  if (!stat.isDirectory()) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      console.error(`无法读取目录: ${current}: ${error.message}`);
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

function suspiciousText(value) {
  const text = String(value || '');
  const reasons = [];
  if (REPLACEMENT_MARKERS.test(text)) reasons.push('replacement-character');
  if (UTF8_MOJIBAKE_MARKERS.test(text)) reasons.push('utf8-mojibake-marker');
  if (GBK_MOJIBAKE_MARKERS.test(text)) reasons.push('gbk-mojibake-marker');
  if (/^[\x00-\xFF\s\d.,!?()[\]{}+\-_/&'" ]+$/.test(text) && /[²³»¼½¾¿±ÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß]/.test(text)) {
    reasons.push('latin-text-with-gbk-pattern');
  }
  return reasons;
}

function fieldReport(label, value) {
  return {
    field: label,
    value: String(value || ''),
    reasons: suspiciousText(value),
  };
}

async function inspectFile(filePath, parseMetadata) {
  const metadata = await parseMetadata(filePath);
  const common = metadata && metadata.common || {};
  const fallbackTitle = path.basename(filePath, path.extname(filePath));
  const rawTitle = String(common.title || '');
  const rawArtist = String(common.artist || (Array.isArray(common.artists) ? common.artists.join(' / ') : '') || '');
  const rawAlbum = String(common.album || '');
  const fields = [
    fieldReport('title', normalizeMetadataText(rawTitle)),
    fieldReport('artist', normalizeMetadataText(rawArtist)),
    fieldReport('album', normalizeMetadataText(rawAlbum)),
  ];
  const suspiciousFields = fields.filter((field) => field.reasons.length);
  return {
    filePath,
    fileName: path.basename(filePath),
    fallbackTitle,
    rawTitle,
    rawArtist,
    rawAlbum,
    title: normalizeMetadataText(rawTitle),
    artist: normalizeMetadataText(rawArtist),
    album: normalizeMetadataText(rawAlbum),
    suspicious: suspiciousFields.length > 0,
    suspiciousFields,
  };
}

async function main() {
  const { options, roots } = parseArgs(process.argv.slice(2));
  if (roots.length !== 1) {
    usage();
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(roots[0]);
  let musicMetadata;
  try {
    musicMetadata = await import('music-metadata');
  } catch (error) {
    console.error(`无法加载 music-metadata: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  let files;
  try {
    files = await collectAudioFiles(root);
  } catch (error) {
    console.error(`无法访问输入路径: ${root}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const records = [];
  const failures = [];
  for (const filePath of files) {
    try {
      records.push(await inspectFile(filePath, (file) => musicMetadata.parseFile(file, { duration: false, skipCovers: true })));
    } catch (error) {
      failures.push({ filePath, error: String(error && (error.message || error.code) || error) });
    }
  }
  const selected = options.all ? records : records.filter((record) => record.suspicious);
  const report = {
    root,
    scanned: files.length,
    parsed: records.length,
    suspicious: records.filter((record) => record.suspicious).length,
    failures,
    records: selected,
  };
  const text = JSON.stringify(report, null, 2);
  if (options.output) {
    await fs.promises.writeFile(path.resolve(options.output), text, 'utf8');
    console.error(`报告已写入: ${path.resolve(options.output)}`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
