"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { session, adminSession } from "./api";

/* Client-side route guards replacing App.jsx's <Protected>/<AdminProtected>.
   Returns `ready` once the login check has run so pages can avoid a flash of
   protected content before a redirect. */
export function useRequireAthlete(): boolean {
    const router = useRouter();
    const [ready, setReady] = useState(false);
    useEffect(() => {
        if (!session.isLoggedIn()) {
            const hasHyfitPrefix = typeof window !== "undefined" && window.location.pathname.startsWith("/hyfitgames");
            router.replace(hasHyfitPrefix ? "/hyfitgames/login" : "/login");
        } else {
            setReady(true);
        }
    }, [router]);
    return ready;
}

export function useRequireAdmin(): boolean {
    const router = useRouter();
    const [ready, setReady] = useState(false);
    useEffect(() => {
        if (!adminSession.isLoggedIn()) {
            const hasHyfitPrefix = typeof window !== "undefined" && window.location.pathname.startsWith("/hyfitgames");
            router.replace(hasHyfitPrefix ? "/hyfitgames/admin/login" : "/admin/login");
        } else {
            setReady(true);
        }
    }, [router]);
    return ready;
}
