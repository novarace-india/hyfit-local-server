import type { ReactNode } from "react";

export default function MobileActionDock({ children }: { children: ReactNode }) {
  return <div className="mobile-action-dock">{children}</div>;
}
