import { cacheLife } from "next/cache";

const dataUrl = process.env.DATA_URL ?? "http://127.0.0.1:3201/";

// Rendered by the root layout on every route. Revalidates after 10 s, expires after 1 h.
export async function getBanner(): Promise<{ version: number; servedAt: string }> {
  "use cache";
  cacheLife("short-revalidate");

  const response = await fetch(`${dataUrl}?source=banner`);
  return response.json();
}

// Rendered by /other only.
export async function getOther(): Promise<{ version: number; servedAt: string }> {
  "use cache";
  cacheLife("hours");

  const response = await fetch(`${dataUrl}?source=other&delay=50`);
  return response.json();
}

// Rendered by /dynamic after its cookie read, so a request reads it from the cache handler.
export async function getGreeting(): Promise<{ version: number; servedAt: string }> {
  "use cache";
  cacheLife("short-revalidate");

  const response = await fetch(`${dataUrl}?source=greeting`);
  return response.json();
}
