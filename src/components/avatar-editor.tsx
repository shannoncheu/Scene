'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';

export function AvatarEditor({ csrf, onSaved }: { csrf: string; onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setImage(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => {
      setStatus('无法解码这张图片');
      setFile(null);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function crop() {
    if (!image) return null;
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    const size = Math.min(w, h) / zoom;
    return { x: ((w - size) / 2) * (1 + panX), y: ((h - size) / 2) * (1 + panY), size, w, h };
  }

  useEffect(() => {
    const c = crop();
    const context = canvas.current?.getContext('2d');
    if (!image || !c || !context) return;
    context.clearRect(0, 0, 256, 256);
    context.drawImage(image, c.x, c.y, c.size, c.size, 0, 0, 256, 256);
  }, [image, zoom, panX, panY]);

  function clampPan(v: number) {
    return Math.max(-1, Math.min(1, v));
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!image || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX, panY };
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart.current || !image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const previewSize = Math.max(1, rect.width);
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    const size = Math.min(w, h) / zoom;
    const maxOffsetX = (w - size) / 2;
    const maxOffsetY = (h - size) / 2;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const scalePerPx = size / previewSize;

    if (maxOffsetX > 0.5) {
      setPanX(clampPan(dragStart.current.panX - (dx * scalePerPx) / maxOffsetX));
    }
    if (maxOffsetY > 0.5) {
      setPanY(clampPan(dragStart.current.panY - (dy * scalePerPx) / maxOffsetY));
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStart.current = null;
    setDragging(false);
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!image || busy) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoom(z => Math.max(1, Math.min(4, Number((z + delta).toFixed(2)))));
  }

  async function save(reset = false) {
    setBusy(true);
    setStatus('');
    try {
      const c = crop();
      if (!reset && (!file || !c)) return;
      const params = c
        ? new URLSearchParams({
            x: String(c.x / c.w),
            y: String(c.y / c.h),
            size: String(c.size / Math.min(c.w, c.h)),
          })
        : '';
      const response = await fetch('/api/avatar' + (!reset ? '?' + params : ''), {
        method: reset ? 'DELETE' : 'POST',
        headers: { 'x-csrf-token': csrf, ...(!reset ? { 'Content-Type': file!.type } : {}) },
        ...(!reset ? { body: file } : {}),
      });
      if (!response.ok) throw new Error();
      setFile(null);
      onSaved();
      setStatus(reset ? '已恢复默认头像' : '头像已保存');
    } catch {
      setStatus('保存失败，请确认文件有效且不超过 5 MB，或重新登录。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="avatar-editor">
      <div className="avatar-editor-actions">
        <label className={`avatar-pick-btn ${busy ? 'is-disabled' : ''}`}>
          <ImagePlus size={15} />
          <span>{image ? '更换图片' : '选择头像'}</span>
          <input
            className="sr-only"
            aria-label="选择头像图片"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) {
                setStatus('请选择不超过 5 MB 的 PNG、JPG 或 WebP 图片');
                return;
              }
              setFile(f);
              setZoom(1);
              setPanX(0);
              setPanY(0);
              setStatus('');
            }}
          />
        </label>
        <button type="button" className="avatar-reset-btn" disabled={busy} onClick={() => save(true)}>
          <RotateCcw size={14} />
          <span>恢复默认头像</span>
        </button>
      </div>
      {image && (
        <div className="avatar-crop-box">
          <canvas
            ref={canvas}
            width={256}
            height={256}
            className={`avatar-crop-preview ${dragging ? 'is-dragging' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          />
          <span className="avatar-crop-hint">直接拖动头像调整位置 · 滚轮或滑块缩放</span>
          <label className="avatar-zoom-row">
            <span>缩放</span>
            <input
              aria-label="头像缩放"
              type="range"
              min="1"
              max="4"
              step="0.05"
              value={zoom}
              onChange={e => setZoom(Number(e.target.value))}
            />
          </label>
          <div className="avatar-crop-submit">
            <button type="button" className="primary-button" disabled={busy} onClick={() => save()}>
              保存头像
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setFile(null);
                setStatus('');
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <p className="settings-help" role="status">
        {status || 'PNG / JPG / WebP，最大 5 MB。仅修改本站头像。'}
      </p>
    </div>
  );
}
