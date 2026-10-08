import { cacheLife } from "next/cache";

const dataUrl = process.env.DATA_URL ?? "http://127.0.0.1:3201/";

// Rendered by the root layout on every route. Revalidates after 10 s, expires after 1 h.
export async function getBanner(): Promise<{ servedAt: string }> {
  "use cache";
  cacheLife("short-revalidate");

  const response = await fetch(`${dataUrl}?source=banner`);
  return response.json();
}

// Rendered by /other only.
export async function getOther(): Promise<{ servedAt: string }> {
  "use cache";
  cacheLife("hours");

  const response = await fetch(`${dataUrl}?source=other&delay=50`);
  return response.json();
}
