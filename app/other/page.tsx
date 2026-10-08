import { getOther } from "../data";

export default async function Other() {
  const { servedAt } = await getOther();

  return <h1>Other page, data fetched at {servedAt}</h1>;
}
