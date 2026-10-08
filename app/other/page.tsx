import { getOther } from "../data";

export default async function Other() {
  const { version, servedAt } = await getOther();

  return <h1>{`Other page data version ${version}, fetched at ${servedAt}`}</h1>;
}
