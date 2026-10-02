import { describe, expect, it } from "vitest";
import { checkProxyUrl } from "../src/secrets";

const opts = { domain: "example.com", allowHttp: false };

describe("security 7: SSRF guard", () => {
  const blocked: [string, string][] = [
    // scheme and credentials
    ["http://api.github.com/", "plain http"],
    ["ftp://api.github.com/", "ftp"],
    ["file:///etc/passwd", "file"],
    ["gopher://api.github.com/", "gopher"],
    ["https://user:pass@api.github.com/", "credentials"],
    ["https://user@api.github.com/", "username only"],
    // names
    ["https://localhost/", "localhost"],
    ["https://LOCALHOST./", "localhost, uppercase + trailing dot"],
    ["https://foo.localhost/", "*.localhost"],
    ["https://printer.local/", "*.local"],
    ["https://metadata.google.internal/", "*.internal"],
    ["https://intranet/", "single label"],
    ["https://example.com/", "platform apex"],
    ["https://ramzy.example.com/_api/kv", "platform namespace"],
    ["https://deep.ns.example.com/", "platform deep subdomain"],
    // IPv4
    ["https://0.0.0.0/", "0.0.0.0"],
    ["https://127.0.0.1/", "loopback"],
    ["https://127.1.2.3/", "loopback /8"],
    ["https://10.0.0.1/", "10/8"],
    ["https://172.16.0.1/", "172.16/12 low"],
    ["https://172.31.255.255/", "172.16/12 high"],
    ["https://192.168.1.1/", "192.168/16"],
    ["https://169.254.169.254/latest/meta-data/", "link-local / metadata"],
    ["https://100.64.0.1/", "CGNAT low"],
    ["https://100.127.255.254/", "CGNAT high"],
    ["https://224.0.0.1/", "multicast"],
    ["https://255.255.255.255/", "broadcast"],
    ["https://2130706433/", "decimal-encoded 127.0.0.1"],
    ["https://0x7f000001/", "hex-encoded 127.0.0.1"],
    ["https://0177.0.0.1/", "octal-encoded 127.0.0.1"],
    ["https://127.1/", "short-form 127.0.0.1"],
    // IPv6
    ["https://[::1]/", "IPv6 loopback"],
    ["https://[::]/", "IPv6 unspecified"],
    ["https://[fe80::1]/", "IPv6 link-local"],
    ["https://[fc00::1]/", "IPv6 unique-local fc"],
    ["https://[fd12:3456::1]/", "IPv6 unique-local fd"],
    ["https://[ff02::1]/", "IPv6 multicast"],
    ["https://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["https://[::ffff:10.0.0.1]/", "IPv4-mapped private"],
    ["https://[::ffff:a9fe:a9fe]/", "IPv4-mapped metadata, hex form"],
    ["https://[64:ff9b::a00:1]/", "NAT64 of 10.0.0.1"],
    ["https://[2002:7f00:1::]/", "6to4 of 127.0.0.1"],
    // junk
    ["not a url", "unparseable"],
    ["/relative/path", "relative"],
  ];

  it.each(blocked)("blocks %s (%s)", (url) => {
    expect(checkProxyUrl(url, opts)).not.toBeNull();
  });

  const allowed = [
    "https://api.github.com/repos",
    "https://httpbin.org/anything?x=1",
    "https://8.8.8.8/",
    "https://172.32.0.1/",
    "https://100.128.0.1/",
    "https://[2606:4700:4700::1111]/",
    "https://example.com.evil.org/",
    "https://notexample.com/",
    "https://api.example.org:8443/v1",
  ];

  it.each(allowed)("allows %s", (url) => {
    expect(checkProxyUrl(url, opts)).toBeNull();
  });

  it("allows http only in dev mode", () => {
    expect(checkProxyUrl("http://httpbin.org/", { ...opts, allowHttp: true })).toBeNull();
    expect(checkProxyUrl("http://127.0.0.1/", { ...opts, allowHttp: true })).not.toBeNull();
  });

  it("never echoes the URL in the reason", () => {
    const reason = checkProxyUrl("https://user:sk-supersecret@api.github.com/", opts)!;
    expect(reason).not.toContain("supersecret");
  });
});
