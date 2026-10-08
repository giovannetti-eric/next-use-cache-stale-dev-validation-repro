import { getBanner } from "./data";

export async function Banner() {
  const { version, servedAt } = await getBanner();

  return <p>{`Banner data version ${version}, fetched at ${servedAt}`}</p>;
}
