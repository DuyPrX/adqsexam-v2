'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface TreeQrCodeProps {
  /** The URL students scan to join. */
  value: string;
  /** Rendered pixel size of the QR image. */
  size?: number;
}

/**
 * Student-entry QR code (Phase 7.3).
 *
 * Rendered to a data URL rather than a CSS-only QR so the projector's "memory
 * picture" and any future print path can embed the same image. Generation is
 * async and off the render path, so a failure degrades to a visible fallback
 * message instead of breaking the whole projector screen.
 */
export function TreeQrCode({ value, size = 180 }: TreeQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      // Level M survives a projector's scaling/compression without inflating the
      // module count the way level H would at this size.
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) {
          setDataUrl(null);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <p className="rounded-lg bg-white/10 p-4 text-center text-xs text-slate-300">
        Không tạo được mã QR. Học sinh có thể nhập mã phiên thủ công.
      </p>
    );
  }

  return (
    <div className="rounded-xl bg-white p-2">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a generated data URL has no loader/optimisation benefit.
        <img
          src={dataUrl}
          alt="Mã QR để học sinh tham gia"
          width={size}
          height={size}
          className="block"
        />
      ) : (
        <div style={{ width: size, height: size }} className="animate-pulse bg-slate-200" />
      )}
    </div>
  );
}
