import { lanAddresses, readBuilds } from "./builds";
import AppDownloads from "./app-downloads";

// The folder contents are the page. Without this Next would read it once at
// build time and serve that forever, so a build copied in after `next build`
// would never show up — which is precisely when builds get copied in.
export const dynamic = "force-dynamic";

export const metadata = {
    title: "HYFIT — Install the field apps",
    robots: { index: false, follow: false },
};

export default async function AppDownloadsPage() {
    const [builds, hosts] = await Promise.all([readBuilds(), Promise.resolve(lanAddresses())]);
    return <AppDownloads builds={builds} lanHosts={hosts} />;
}
