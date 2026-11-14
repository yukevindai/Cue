"use client";

import { useId, useState, type ChangeEvent } from "react";
import { Avatar, Button, buttonClass, Spinner } from "@/components/ui";
import { cx } from "@/lib/cx";
import { getBrowserSupabase } from "@/lib/supabase/browser";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 800;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Downscale to MAX_EDGE on the long side and re-encode as JPEG; the original on any failure. */
async function prepare(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.type === "image/jpeg" ? blob : file;
  } catch {
    return file;
  }
}

export function PhotoPicker({
  userId,
  name,
  photoUrl,
  onChange,
}: {
  userId: string;
  name: string;
  photoUrl: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // allow picking the same file again after a failure
    if (!file) return;
    setError(null);
    setInfo(null);

    if (!ACCEPT.includes(file.type)) {
      setError("That file isn't a JPEG, PNG or WebP image. Choose a photo in one of those formats.");
      return;
    }
    if (file.size > MAX_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setError(`That photo is ${mb} MB and the limit is 5 MB. Choose a smaller one.`);
      return;
    }

    setUploading(true);
    try {
      const body = await prepare(file);
      const type = body.type || file.type;
      const path = `${userId}/${crypto.randomUUID()}.${EXT[type] ?? "jpg"}`;
      const supabase = getBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, body, { contentType: type, cacheControl: "3600", upsert: false });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      onChange(data.publicUrl);
      setInfo("Photo added. Save to keep it.");
    } catch {
      setError("The photo didn't upload. Check your connection and try again; your other changes are still here.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-4 sm:gap-5">
      <div className="relative shrink-0">
        <Avatar name={name || "You"} src={photoUrl} size={96} />
        {uploading ? (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-paper/75 text-ember-deep">
            <Spinner size={28} />
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            id={inputId}
            type="file"
            accept={ACCEPT.join(",")}
            className="peer sr-only"
            disabled={uploading}
            onChange={onFile}
          />
          <label
            htmlFor={inputId}
            aria-disabled={uploading || undefined}
            className={cx(
              buttonClass("secondary"),
              "cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ember",
              uploading && "pointer-events-none opacity-55",
            )}
          >
            {uploading ? "Uploading" : error ? "Try again" : photoUrl ? "Change photo" : "Add a photo"}
          </label>
          {photoUrl && !uploading ? (
            <Button
              variant="quiet"
              onClick={() => {
                setError(null);
                setInfo("Photo removed. Save to keep that.");
                onChange(null);
              }}
            >
              Remove photo
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-sm text-ink-soft">JPEG, PNG or WebP, up to 5 MB.</p>
        <div role="status" className="text-sm">
          {info && !error ? <p className="mt-1 font-medium text-ink">{info}</p> : null}
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-sm font-medium text-ember-deep">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
