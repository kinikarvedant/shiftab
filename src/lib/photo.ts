// Camera/file -> square 256px JPEG data URL, resized on the device (small enough to sync everywhere).
export async function photoFromFile(file: File, size = 256): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** Logo -> PNG/WebP data URL (max 512px, transparency kept) + its dominant brand colours. SVGs are rasterised, so no script ever ships. */
export async function logoFromFile(file: File): Promise<{ dataUrl: string; palette: string[] }> {
  if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)) throw new Error('Use a PNG, JPG, WebP or SVG logo.');
  if (file.size > 5_000_000) throw new Error('That file is over 5 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const k = Math.min(1, 512 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 380_000) dataUrl = canvas.toDataURL('image/webp', 0.9);
    if (dataUrl.length > 380_000) throw new Error('That logo is too detailed to store. Try a simpler or smaller file.');
    const small = document.createElement('canvas');
    small.width = small.height = 64;
    const sctx = small.getContext('2d')!;
    sctx.drawImage(canvas, 0, 0, 64, 64);
    const { paletteFromPixels } = await import('../../shared/theme.ts');
    return { dataUrl, palette: paletteFromPixels(sctx.getImageData(0, 0, 64, 64).data) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
