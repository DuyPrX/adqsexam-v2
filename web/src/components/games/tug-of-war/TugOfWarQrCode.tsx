'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface TugOfWarQrCodeProps {
  value: string;
  size?: number;
}

export function TugOfWarQrCode({ value, size = 180 }: TugOfWarQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
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
        Không tạo được mã QR.
      </p>
    );
  }

  return (
    <div className="rounded-xl bg-white p-2 shadow-md inline-block">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt="Mã QR tham gia"
          width={size}
          height={size}
          className="block rounded-lg"
        />
      ) : (
        <div
          style={{ width: size, height: size }}
          className="flex items-center justify-center bg-slate-100 text-[11px] text-slate-400"
        >
          Đang tạo QR...
        </div>
      )}
    </div>
  );
}
