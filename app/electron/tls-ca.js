import tls from 'node:tls';

/**
 * 内网 HTTPS 网关用公司 CA 重签阿里云证书。
 * Node 的 ws/fetch 默认只认 Mozilla 捆绑 CA，这里并进系统已信任的 CA。
 * 校验不关。建连时把返回值传给 ws 的 ca 选项。
 */
export function ensureSystemCa() {
  if (typeof tls.getCACertificates !== 'function') return undefined;
  try {
    const system = tls.getCACertificates('system');
    if (!system.length) return undefined;
    const ca = [...tls.getCACertificates('default'), ...system];
    tls.setDefaultCACertificates(ca);
    return ca;
  } catch {
    return undefined;
  }
}

ensureSystemCa();
