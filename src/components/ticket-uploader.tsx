'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCw, Ticket, Trash2, Upload } from 'lucide-react';

const ticketErrors: Record<string, string> = {
  UNAUTHORIZED: '登录已过期，请重新登录。',
  CSRF_REJECTED: '页面会话校验未通过，请刷新后重试。',
  FILE_TOO_LARGE: '图片大小不能超过 10 MB。',
  FILE_INVALID: '无法识别该图片，请选择清晰的 PNG、JPG 或 WebP 照片。',
  ITEM_NOT_FOUND: '未找到对应电影或票根记录。',
};

function ticketFailureMessage(status: number, code?: string, fallback = '操作失败，请稍后重试。') {
  if (status === 413) return '图片体积过大，请换一张不超过 10 MB 的照片。';
  if (status >= 502) return '服务器正在维护或暂时无响应，请稍后重试。';
  return (code && ticketErrors[code]) || fallback;
}

export function TicketUploader({
  mediaId,
  currentUrl,
  csrf,
  onChanged,
}: {
  mediaId: string;
  currentUrl: string | null;
  csrf: string;
  onChanged: (nextUrl: string | null) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setConfirmRemove(false);
    setStatus('');
    setError('');
  }, [mediaId]);

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  async function applyChange(nextUrl: string | null, okText: string) {
    setStatus(okText);
    try {
      await onChanged(nextUrl);
    } catch {
      setError('票根已保存，但刷新列表失败，请稍后手动刷新。');
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('请选择 PNG、JPG 或 WebP 格式的票根照片。');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('图片大小不能超过 10 MB。');
      return;
    }
    setBusy(true);
    setConfirmRemove(false);
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/ticket?id=${encodeURIComponent(mediaId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'x-csrf-token': csrf,
        },
        body: file,
      });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string; autoCropped?: boolean; ticketStub?: string | null };
      if (!response.ok) {
        throw new Error(ticketFailureMessage(response.status, data.error, '上传或裁剪失败，请换一张清晰点的票根照片重试。'));
      }
      await applyChange(data.ticketStub ?? null, data.autoCropped ? '已自动识别并裁剪票根' : '票根已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请稍后重试。');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function rotateTicket() {
    setBusy(true);
    setConfirmRemove(false);
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/ticket?id=${encodeURIComponent(mediaId)}&rotate=90`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string; ticketStub?: string | null };
      if (!response.ok) {
        throw new Error(ticketFailureMessage(response.status, data.error, '旋转失败，请稍后重试。'));
      }
      await applyChange(data.ticketStub ?? null, '已顺时针旋转 90°');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  async function removeTicket() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy(true);
    setConfirmRemove(false);
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/ticket?id=${encodeURIComponent(mediaId)}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': csrf },
      });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(ticketFailureMessage(response.status, data.error, '移除票根失败，请稍后重试。'));
      }
      await applyChange(null, '已移除票根');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket-uploader">
      <div className="ticket-uploader-head">
        <span>
          <Ticket size={15} />
          影院票根
        </span>
        <div className="ticket-uploader-actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={e => void handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            className="ticket-btn"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}
            {currentUrl ? '更换票根' : '上传票根（自动裁剪）'}
          </button>
          {currentUrl && (
            <>
              <button
                type="button"
                className="ticket-btn"
                disabled={busy}
                onClick={() => void rotateTicket()}
              >
                <RotateCw size={14} />
                旋转 90°
              </button>
              <button
                type="button"
                className="ticket-btn danger"
                disabled={busy}
                onClick={() => void removeTicket()}
              >
                <Trash2 size={14} />
                {confirmRemove ? '确认移除' : '移除'}
              </button>
            </>
          )}
        </div>
      </div>

      {currentUrl ? (
        <div className="ticket-preview">
          <img src={currentUrl} alt="影院票根" width={240} height={320} />
        </div>
      ) : (
        <p className="ticket-hint">拍摄或选择纸质票根照片，系统会自动裁剪掉周围桌面背景，只保留票面。</p>
      )}

      {status && <p className="ticket-status" role="status">{status}</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
    </div>
  );
}
