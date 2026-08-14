// Check-in is its own app: its own URL, its own sign-in, its own session
// cookie. What it shares with the judge app is the field styling — one HYFIT
// field look, one set of tokens — so the stylesheets are imported from there
// rather than forked. Anything that must differ between the two apps belongs
// in a class on this side, not in a second copy of these files.
import "../judge/globals.css";
import "../judge/operations.css";
import "../judge/brand.css";
import "../judge/tablet.css";
import "../judge/theme.css";

export const metadata = {
  title: "HYFIT Games Check-in",
  description: "Wristband and transponder counters for HYFIT Games.",
  robots: { index: false, follow: false },
};

// Same theme bootstrap as the judge app, reading the same stored preference:
// the two run on the same borrowed tablets, and a counter that flashes white
// at night while the judging app stays dark reads as a different product.
const THEME_BOOTSTRAP = `try{if(localStorage.getItem("hyfit-judge-theme")==="dark"){document.documentElement.dataset.theme="dark"}}catch(e){}`;

export default function CheckinLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      {children}
    </>
  );
}
