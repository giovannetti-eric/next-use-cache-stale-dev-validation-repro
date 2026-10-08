import { getBanner } from "./data";

export async function Banner() {
  const { servedAt } = await getBanner();

  return <p>Banner data fetched at {servedAt}</p>;
}
