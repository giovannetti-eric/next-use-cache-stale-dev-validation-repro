import { cookies } from "next/headers";
import { Suspense } from "react";
import { getGreeting } from "../data";

async function Visitor() {
  const cookieStore = await cookies();
  const { version, servedAt } = await getGreeting();

  return <p>{`Greeting data version ${version}, fetched at ${servedAt}, for a request with ${cookieStore.size} cookies`}</p>;
}

// The root layout's banner is in the static shell. The cookie read and the cached
// greeting after it are rendered at request time.
export default function Dynamic() {
  return (
    <main>
      <h1>Dynamic page</h1>
      <Suspense fallback={<p>Loading visitor</p>}>
        <Visitor />
      </Suspense>
    </main>
  );
}
