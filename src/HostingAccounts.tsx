import { useCallback, useEffect, useState } from "react";
import type { HostingConnection, Locale, NativeHostingProvider } from "../shared/types";
import { hostingLabels } from "../shared/hosting";
import { translate } from "./i18n";

export const hostingError = (reason: unknown) =>
  (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ""
  );

export function HostingAccounts({
  locale,
  onChanged,
  expanded = false
}: {
  locale: Locale;
  onChanged?: () => void;
  expanded?: boolean;
}) {
  const t = translate(locale);
  const [provider, setProvider] = useState<NativeHostingProvider>("bitbucket");
  const [baseUrl, setBaseUrl] = useState("https://bitbucket.org");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [connections, setConnections] = useState<HostingConnection[]>([]);
  const [secure, setSecure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const state = await window.gitcat.getHostingConnections();
      setConnections(state.connections);
      setSecure(state.secureStorage);
    } catch (reason) {
      setError(hostingError(reason));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const state = await window.gitcat.connectHosting({ provider, baseUrl, username, token });
      setConnections(state.connections);
      setSecure(state.secureStorage);
      setToken("");
      setNotice(t("hostingAccountSaved"));
      onChanged?.();
    } catch (reason) {
      setError(hostingError(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const state = await window.gitcat.removeHostingConnection(id);
      setConnections(state.connections);
      setNotice(t("hostingAccountRemoved"));
      onChanged?.();
    } catch (reason) {
      setError(hostingError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="settings-section hosting-accounts" open={expanded || undefined}>
      <summary>{t("hostingAccountsTitle")}</summary>
      <p className="settings-intro">{t("hostingAccountsIntro")}</p>
      <p>
        {t("hostingTokenIntro")}{" "}
        <button
          type="button"
          className="ghost-button small"
          onClick={() =>
            void window.gitcat
              .openHelpPage(
                provider === "bitbucket"
                  ? "bitbucket_tokens"
                  : provider === "azure"
                    ? "azure_tokens"
                    : "bitbucket_dc_tokens"
              )
              .catch((reason) => setError(hostingError(reason)))
          }
        >
          {t("hostingCreateToken")}
        </button>
      </p>
      <p>{t("hostingTokenPrivacy")}</p>
      {connections.map((connection) => (
        <div className="hosting-account" key={connection.id}>
          <strong>
            {hostingLabels[connection.provider]} · {connection.label}
          </strong>
          <span>
            {connection.username || connection.accountId} · {connection.baseUrl}
          </span>
          <button
            type="button"
            className="ghost-button small"
            disabled={busy}
            onClick={() => void remove(connection.id)}
          >
            {t("hostingRemoveAccount")}
          </button>
        </div>
      ))}
      <fieldset disabled={busy || !secure}>
        <label>
          {t("hostingServiceLabel")}
          <select
            value={provider}
            onChange={(event) => {
              const next = event.target.value as NativeHostingProvider;
              setProvider(next);
              setBaseUrl(next === "bitbucket" ? "https://bitbucket.org" : "");
              setToken("");
              setUsername("");
              setError("");
            }}
          >
            <option value="bitbucket">Bitbucket Cloud</option>
            <option value="bitbucket_dc">Bitbucket Data Center</option>
            <option value="azure">Azure DevOps / Azure DevOps Server</option>
          </select>
        </label>
        <label>
          {t("hostingServiceAddress")}
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={
              provider === "azure"
                ? "https://dev.azure.com/your-organization"
                : provider === "bitbucket_dc"
                  ? "https://code.company.example/bitbucket"
                  : "https://bitbucket.org"
            }
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {provider !== "azure" && (
          <label>
            {provider === "bitbucket" ? t("hostingAtlassianEmail") : t("hostingBitbucketUsername")}
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <label>
          {t("hostingTokenLabel")}
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
          <small>
            {provider === "azure"
              ? t("hostingAzureTokenHelp")
              : provider === "bitbucket"
                ? t("hostingCloudTokenHelp")
                : t("hostingDataCenterTokenHelp")}
          </small>
        </label>
        <button
          type="button"
          className="outline-button"
          onClick={() => void connect()}
          disabled={!baseUrl.trim() || !token.trim() || (provider !== "azure" && !username.trim())}
        >
          {busy ? t("hostingVerifying") : t("hostingVerifyAccount")}
        </button>
      </fieldset>
      {!secure && <p role="alert">{t("hostingSecureStorageUnavailable")}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
