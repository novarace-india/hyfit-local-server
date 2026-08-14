import "./globals.css";
import "./operations.css";
import "./brand.css";
import "./tablet.css";
import "./theme.css";

export const metadata = {
  title: "HYFIT Games Judge App",
  description: "Official field judging app for HYFIT Games.",
  robots: { index: false, follow: false },
};

// Applies the stored theme before the first paint. Without this a judge who
// picked dark would see a white flash on every navigation, which on a field
// tablet at night is worse than no dark mode at all. Light is the default, so
// the attribute is only ever set for an explicit dark choice.
const THEME_BOOTSTRAP = `try{if(localStorage.getItem("hyfit-judge-theme")==="dark"){document.documentElement.dataset.theme="dark"}}catch(e){}`;

export default function JudgeLayout({
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
