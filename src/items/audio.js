/**
 * items/audio.js — 管理员上传音频的容器/时长/采样率校验
 *
 * 只做「能不能安全播放」的硬校验 + 可读的质量警告：
 *  - 读秒语音包：单声道优先、44.1/48kHz、0.25–2.5 秒、同一容器
 *  - BGM：mp3/ogg/wav、1 秒–30 分钟、≤12MB
 *
 * 容器嗅探复用 assets.audioKind（只看文件头），时长/采样率用纯 JS 的
 * music-metadata（不依赖 ffmpeg，部署机无需安装编译工具链）。
 */
'use strict';

const assets = require('./assets');
const mm = require('music-metadata');

const BYOYOMI_MAX_BYTES = 2 * 1024 * 1024;
const BGM_MAX_BYTES = 12 * 1024 * 1024;

function baseInfo(buf) {
  const kind = assets.audioKind(buf);
  return { kind, size: buf.length };
}

/**
 * 读取音频元数据（直接在内存里解析，扩展包无需落临时文件）。
 * @param {Buffer} buf 文件内容
 * @returns {Promise<{ok:true, info:object}|{ok:false, error:string, code:string}>}
 */
async function probe(buf) {
  const b = baseInfo(buf);
  if (!b.kind) return { ok: false, error: '无法识别的音频容器（仅支持 mp3 / ogg / wav）', code: 'BAD_AUDIO' };
  let meta;
  try {
    meta = await mm.parseBuffer(buf, { size: buf.length }, { duration: true, skipCovers: true });
  } catch (_) {
    return { ok: false, error: '音频文件损坏或无法解析', code: 'BAD_AUDIO' };
  }
  const f = (meta && meta.format) || {};
  const duration = Number(f.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: '无法读取音频时长', code: 'BAD_AUDIO' };
  }
  return {
    ok: true,
    info: {
      kind: b.kind,
      size: b.size,
      container: f.container || null,
      codec: f.codec || null,
      sampleRate: Number(f.sampleRate) || null,
      channels: Number(f.numberOfChannels || f.channels) || null,
      bitrate: Number(f.bitrate) || null,
      durationMs: Math.round(duration * 1000),
    },
  };
}

/** 读秒单条：硬性时长/采样率；质量项给 warning */
async function validateByoyomiCue(buf, key) {
  if (!buf || buf.length > BYOYOMI_MAX_BYTES) {
    return { ok: false, error: `${key} 文件过大（上限 2MB）`, code: 'TOO_LARGE' };
  }
  const r = await probe(buf);
  if (!r.ok) return { ...r, key };
  const a = r.info;
  if (a.durationMs < 250 || a.durationMs > 2500) {
    return { ok: false, error: `${key} 时长 ${a.durationMs}ms，需在 250–2500ms`, code: 'BAD_DURATION', info: a };
  }
  if (a.sampleRate && a.sampleRate !== 44100 && a.sampleRate !== 48000) {
    return { ok: false, error: `${key} 采样率 ${a.sampleRate}Hz，需 44100 或 48000`, code: 'BAD_SAMPLE_RATE', info: a };
  }
  if (a.channels && a.channels !== 1) {
    return { ok: false, error: `${key} 为 ${a.channels} 声道，读秒包要求单声道`, code: 'BAD_CHANNELS', info: a };
  }
  const warnings = [];
  if (!a.channels) warnings.push(`${key} 无法从容器头读取声道，请人工确认单声道`);
  if (a.bitrate && a.bitrate < 64000) warnings.push(`${key} 码率 ${Math.round(a.bitrate / 1000)}kbps，建议 ≥96kbps`);
  if (a.durationMs < 400 || a.durationMs > 1800) warnings.push(`${key} 时长 ${a.durationMs}ms，建议 400–1800ms`);
  if (a.sampleRate && a.sampleRate !== 44100) warnings.push(`${key} 采样率 ${a.sampleRate}Hz，建议 44100Hz`);
  return { ok: true, info: a, warnings };
}

/** BGM：硬性容器/时长/大小；质量项给 warning */
async function validateBgm(buf, key) {
  if (!buf || buf.length > BGM_MAX_BYTES) {
    return { ok: false, error: `${key} 文件过大（上限 12MB）`, code: 'TOO_LARGE' };
  }
  const r = await probe(buf);
  if (!r.ok) return { ...r, key };
  const a = r.info;
  if (a.durationMs < 1000 || a.durationMs > 30 * 60 * 1000) {
    return { ok: false, error: `${key} 时长 ${a.durationMs}ms，需在 1 秒–30 分钟`, code: 'BAD_DURATION', info: a };
  }
  const warnings = [];
  if (a.durationMs < 10000) warnings.push(`${key} 时长不足 10 秒，循环播放可能显得重复`);
  if (a.durationMs > 10 * 60 * 1000) warnings.push(`${key} 超过 10 分钟，建议压缩体积`);
  return { ok: true, info: a, warnings };
}

module.exports = {
  BYOYOMI_MAX_BYTES,
  BGM_MAX_BYTES,
  probe,
  validateByoyomiCue,
  validateBgm,
};
