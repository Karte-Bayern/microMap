// Command tilecache is a tiny local caching proxy for XYZ raster tiles.
//
// It exists purely to make local development of microMap.js pleasant: you
// can disable the browser's HTTP cache in DevTools (Network > "Disable
// cache") to always see how the map renders on a cold, first-hit load, while
// this proxy still only ever fetches each tile from the real tile server
// once and serves every later request straight from disk. That keeps you
// from hammering a public tile provider (e.g. tile.openstreetmap.org) with
// repeated requests while iterating on the map.
//
// Raster XYZ tiles have one fixed -upstream host and a predictable
// {z}/{x}/{y}.ext path, so they get their own route. Vector-tile sources
// (MVT/PBF, fetched via microMap.vector.js's pluggable `fetch` option) don't:
// the vector demo lets you pick between several providers on different
// hosts, plus TileJSON metadata endpoints that point at yet another host.
// /fetch?u=<url> covers that case generically for public absolute http(s)
// URLs, keyed by the URL itself regardless of host or content type. It
// rejects userinfo, localhost/private/link-local targets and unsafe redirect
// hops, rechecks DNS at dial time, and bounds both each response and the
// total cache. See -h for -allow-remote-fetch to disable it.
//
// Usage:
//
//	cd tools/tilecache && go run . -static ../..
//	# then point microMap's `tiles` option at:
//	#   http://127.0.0.1:8091/{z}/{x}/{y}.png
//	# and route vector-tile/TileJSON fetches through:
//	#   http://127.0.0.1:8091/fetch?u=<encodeURIComponent(url)>
//
// See -h for flags (upstream server, cache directory, User-Agent, ...).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var tilePathPattern = regexp.MustCompile(`^/([0-9]{1,2})/([0-9]+)/([0-9]+)\.(png|jpg|jpeg|webp)$`)

const (
	defaultMaxResponseBytes int64 = 8 << 20
	defaultMaxCacheBytes    int64 = 256 << 20
	maxContentTypeBytes           = 512
	maxRemoteRedirects            = 3
)

type lookupIPFunc func(context.Context, string) ([]net.IP, error)

var maxInt64 = int64(^uint64(0) >> 1)

func main() {
	addr := flag.String("addr", "127.0.0.1:8091", "address to listen on")
	upstream := flag.String("upstream", "https://tile.openstreetmap.org", "upstream tile server base URL (no trailing slash, no {z}/{x}/{y})")
	cacheDir := flag.String("cache", "./tilecache-data", "directory to store cached tiles in")
	userAgent := flag.String("user-agent", "microMap.js-dev-tilecache/1.0 (local development proxy)", "User-Agent header sent to the upstream tile server")
	maxInflight := flag.Int("max-inflight", 2, "maximum concurrent upstream requests, to stay polite to the tile provider")
	staticDir := flag.String("static", ".", "directory to serve non-tile requests from as static files (the repo root, so /demo/ works); set to \"\" to disable and 404 instead")
	allowRemoteFetch := flag.Bool("allow-remote-fetch", true, "enable GET /fetch?u=<url>, a generic same-origin cache for public vector-tile/TileJSON URLs")
	maxResponseBytes := flag.Int64("max-response-bytes", defaultMaxResponseBytes, "maximum bytes cached per upstream response")
	maxCacheBytes := flag.Int64("max-cache-bytes", defaultMaxCacheBytes, "maximum total bytes retained in the tile cache")
	flag.Parse()
	if *maxInflight < 1 {
		log.Fatalf("tilecache: -max-inflight must be at least 1 (got %d)", *maxInflight)
	}
	if !validResponseLimit(*maxResponseBytes) {
		log.Fatalf("tilecache: -max-response-bytes must be between 1 and %d (got %d)", maxInt64-1, *maxResponseBytes)
	}
	if *maxCacheBytes < 1 {
		log.Fatalf("tilecache: -max-cache-bytes must be at least 1 (got %d)", *maxCacheBytes)
	}

	if err := os.MkdirAll(*cacheDir, 0o755); err != nil {
		log.Fatalf("tilecache: create cache dir %q: %v", *cacheDir, err)
	}

	// Idle connections to the upstream tile server are pooled per-host so a
	// burst of cache misses (panning into freshly-seen tiles) reuses TLS
	// connections instead of paying a fresh handshake for every one of the
	// up to -max-inflight concurrent fetches.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = max(*maxInflight, 4)
	transport.IdleConnTimeout = 90 * time.Second

	lookupIP := defaultLookupIP
	proxy := &tileProxy{
		upstream:         strings.TrimRight(*upstream, "/"),
		cacheDir:         *cacheDir,
		userAgent:        *userAgent,
		client:           &http.Client{Timeout: 15 * time.Second, Transport: transport},
		remoteClient:     newRemoteClient(transport, lookupIP, 15*time.Second),
		lookupIP:         lookupIP,
		maxResponseBytes: *maxResponseBytes,
		maxCacheBytes:    *maxCacheBytes,
		sem:              make(chan struct{}, *maxInflight),
		inflight:         make(map[string]chan struct{}),
	}
	if *staticDir != "" {
		proxy.static = staticHandler(*staticDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", proxy.handle)
	if *allowRemoteFetch {
		mux.HandleFunc("/fetch", proxy.handleFetch)
	}

	// Explicit timeouts rather than the zero-value bare http.ListenAndServe:
	// a client that opens a connection and trickles headers/body slowly (or
	// never finishes) would otherwise tie up a goroutine indefinitely.
	server := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("tilecache: listening on http://%s", *addr)
	log.Printf("tilecache: proxying to %s, caching in %s", proxy.upstream, *cacheDir)
	log.Printf("tilecache: point microMap's `tiles` option at http://%s/{z}/{x}/{y}.png", *addr)
	if *allowRemoteFetch {
		log.Printf("tilecache: generic cache at http://%s/fetch?u=<url> for public vector-tile/TileJSON sources (max %d bytes each, %d bytes total)", *addr, *maxResponseBytes, *maxCacheBytes)
	}
	if *staticDir != "" {
		log.Printf("tilecache: serving static files from %s, try http://%s/demo/?tiles=local", *staticDir, *addr)
	}
	log.Fatal(server.ListenAndServe())
}

type tileProxy struct {
	upstream         string
	cacheDir         string
	userAgent        string
	client           *http.Client
	remoteClient     *http.Client
	lookupIP         lookupIPFunc
	maxResponseBytes int64
	maxCacheBytes    int64
	sem              chan struct{}
	static           http.Handler // serves non-tile requests when non-nil; 404s otherwise

	mu       sync.Mutex
	cacheMu  sync.Mutex
	inflight map[string]chan struct{}
}

func (p *tileProxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	m := tilePathPattern.FindStringSubmatch(r.URL.Path)
	if m == nil {
		if p.static != nil {
			p.static.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	z, x, y, ext := m[1], m[2], m[3], m[4]
	if !validTile(z, x, y) {
		http.NotFound(w, r)
		return
	}
	cachePath := filepath.Join(p.cacheDir, z, x, y+"."+ext)

	if p.serveIfCached(w, r, cachePath) {
		return
	}

	p.fetchOnce(z+"/"+x+"/"+y+"."+ext, cachePath, p.upstream+"/"+z+"/"+x+"/"+y+"."+ext, p.client)

	if !p.serveIfCached(w, r, cachePath) {
		http.Error(w, "tile fetch failed, see server log", http.StatusBadGateway)
	}
}

// handleFetch is a generic cache for anything that isn't a raster XYZ tile
// on the single -upstream host: vector-tile (MVT/PBF) sources and their
// TileJSON metadata live on whatever host the caller picks at runtime, so
// unlike raster tiles they can't be routed through one fixed upstream. The
// cache key is the URL itself (hashed), and the response's Content-Type is
// preserved via a sidecar file since there's no reliable file extension to
// infer it from.
func (p *tileProxy) handleFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw := r.URL.Query().Get("u")
	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" || target.User != nil {
		http.Error(w, "tilecache: ?u= must be an absolute http:// or https:// URL", http.StatusBadRequest)
		return
	}
	if err := validateRemoteURL(r.Context(), target, p.lookupIP); err != nil {
		http.Error(w, "tilecache: remote URL is not allowed", http.StatusForbidden)
		return
	}
	// Karte.Bayern's TileJSON revision and imagery/source notices can change
	// independently of an individual tile URL. Keep those responses live and
	// retain imagery provenance headers instead of freezing them in the local
	// development cache. Revisioned MVT tiles still use the cache below.
	if volatileKarteBayernURL(target) {
		p.fetchUncached(w, r, target.String())
		return
	}

	hash := cacheKeyFor(raw)
	cachePath := filepath.Join(p.cacheDir, "fetch", hash)

	if p.serveIfCached(w, r, cachePath) {
		return
	}

	p.fetchOnce("fetch/"+hash, cachePath, target.String(), p.remoteHTTPClient())

	if !p.serveIfCached(w, r, cachePath) {
		http.Error(w, "fetch failed, see server log", http.StatusBadGateway)
	}
}

func volatileKarteBayernURL(target *url.URL) bool {
	if target.Scheme != "https" || !strings.EqualFold(target.Host, "karte.bayern") {
		return false
	}
	return target.Path == "/tilejson.json" ||
		(target.Path == "/api/orthophoto/sources" && target.Query().Get("scope") == "runtime") ||
		strings.HasPrefix(target.Path, "/sat/")
}

func (p *tileProxy) fetchUncached(w http.ResponseWriter, r *http.Request, fetchURL string) {
	if p.sem != nil {
		select {
		case p.sem <- struct{}{}:
			defer func() { <-p.sem }()
		case <-r.Context().Done():
			return
		}
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, fetchURL, nil)
	if err != nil {
		http.Error(w, "tilecache: invalid upstream request", http.StatusBadRequest)
		return
	}
	req.Header.Set("User-Agent", p.userAgent)
	if accept := r.Header.Get("Accept"); accept != "" {
		req.Header.Set("Accept", accept)
	}
	client := p.remoteHTTPClient()
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("tilecache: fetch %s: %v", safeURLForLog(fetchURL), err)
		http.Error(w, "tilecache: upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.ContentLength > p.responseLimit() {
		http.Error(w, "tilecache: upstream response too large", http.StatusBadGateway)
		return
	}
	var body []byte
	if r.Method != http.MethodHead {
		body, err = io.ReadAll(io.LimitReader(resp.Body, p.responseLimit()+1))
		if err != nil || int64(len(body)) > p.responseLimit() {
			http.Error(w, "tilecache: upstream response too large", http.StatusBadGateway)
			return
		}
	}
	for _, name := range []string{"Content-Type", "ETag", "Link", "X-KB-Imagery-Source", "X-KB-Imagery-Sources", "X-KB-Imagery-Attribution", "X-KB-Imagery-Source-Notices", "X-KB-Imagery-Processing"} {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func cacheKeyFor(rawURL string) string {
	sum := sha256.Sum256([]byte(rawURL))
	return hex.EncodeToString(sum[:])
}

func (p *tileProxy) serveIfCached(w http.ResponseWriter, r *http.Request, cachePath string) bool {
	f, err := os.Open(cachePath)
	if err != nil {
		return false
	}
	defer f.Close()
	// A cache file only ever exists via fetch's atomic temp-file-then-rename,
	// so its mere presence means a complete response was cached -- including
	// a legitimately empty one (a 204 vector tile). No size check needed.
	info, err := f.Stat()
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", cachedContentType(cachePath))
	w.Header().Set("X-Tile-Cache", "hit")
	if cachedStatus(cachePath) == http.StatusNoContent {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	http.ServeContent(w, r, filepath.Base(cachePath), info.ModTime(), f)
	return true
}

// cachedContentType prefers the Content-Type sidecar written alongside a
// generic /fetch cache entry (its file has no meaningful extension to infer
// from) and falls back to the raster route's extension-based guess.
func cachedContentType(cachePath string) string {
	if raw, ok := readCacheSidecar(cachePath+".ct", maxContentTypeBytes); ok {
		if ct := strings.TrimSpace(string(raw)); ct != "" {
			return ct
		}
	}
	return contentType(cachePath)
}

func cachedStatus(cachePath string) int {
	raw, ok := readCacheSidecar(cachePath+".status", 8)
	if !ok {
		return http.StatusOK
	}
	status, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || status != http.StatusNoContent {
		return http.StatusOK
	}
	return status
}

func readCacheSidecar(path string, maxBytes int64) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	return raw, err == nil && int64(len(raw)) <= maxBytes
}

// fetchOnce fetches fetchURL and writes it into the cache, coalescing
// concurrent requests for the same key into a single upstream fetch so a
// burst of repaints never causes duplicate requests.
func (p *tileProxy) remoteHTTPClient() *http.Client {
	if p.remoteClient != nil {
		return p.remoteClient
	}
	return p.client
}

func (p *tileProxy) fetchOnce(key, cachePath, fetchURL string, client *http.Client) {
	p.mu.Lock()
	if ch, ok := p.inflight[key]; ok {
		p.mu.Unlock()
		<-ch
		return
	}
	done := make(chan struct{})
	p.inflight[key] = done
	p.mu.Unlock()

	defer func() {
		p.mu.Lock()
		delete(p.inflight, key)
		p.mu.Unlock()
		close(done)
	}()

	p.sem <- struct{}{}
	defer func() { <-p.sem }()

	p.fetch(cachePath, fetchURL, client)
}

func (p *tileProxy) fetch(cachePath, fetchURL string, client *http.Client) {
	req, err := http.NewRequest(http.MethodGet, fetchURL, nil)
	if err != nil {
		log.Printf("tilecache: build request for %s: %v", safeURLForLog(fetchURL), err)
		return
	}
	req.Header.Set("User-Agent", p.userAgent)

	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("tilecache: fetch %s: %v", safeURLForLog(fetchURL), err)
		return
	}
	defer resp.Body.Close()
	// Vector-tile sources commonly answer 204 for a tile with no features in
	// it (an empty ocean/countryside area) -- that's a valid, cacheable
	// response, not a failure. Treating it as an error made those tiles
	// perpetually uncacheable: every request re-hit the upstream, and the
	// client (which does treat a 5xx-shaped failure as retryable) kept
	// retrying them forever.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		log.Printf("tilecache: upstream %s returned %s", safeURLForLog(fetchURL), resp.Status)
		return
	}
	maxBytes := p.responseLimit()
	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if len(contentType) > maxContentTypeBytes {
		log.Printf("tilecache: upstream %s has an oversized Content-Type header", safeURLForLog(fetchURL))
		return
	}
	metadataBytes := cacheMetadataBytes(contentType, resp.StatusCode)
	if metadataBytes > maxBytes || resp.ContentLength > maxBytes-metadataBytes {
		log.Printf("tilecache: upstream %s exceeds the %d-byte response limit", safeURLForLog(fetchURL), maxBytes)
		return
	}

	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		log.Printf("tilecache: create dir for %s: %v", cachePath, err)
		return
	}
	out, err := os.CreateTemp(filepath.Dir(cachePath), "."+filepath.Base(cachePath)+".*")
	if err != nil {
		log.Printf("tilecache: create temp file for %s: %v", cachePath, err)
		return
	}
	tmp := out.Name()
	bodyLimit := maxBytes - metadataBytes
	written, err := io.Copy(out, io.LimitReader(resp.Body, bodyLimit+1))
	if err != nil {
		out.Close()
		os.Remove(tmp)
		log.Printf("tilecache: write %s: %v", tmp, err)
		return
	}
	if written > bodyLimit {
		out.Close()
		os.Remove(tmp)
		log.Printf("tilecache: upstream %s exceeds the %d-byte response limit", safeURLForLog(fetchURL), maxBytes)
		return
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		log.Printf("tilecache: close %s: %v", tmp, err)
		return
	}
	if err := p.commitCache(tmp, cachePath, contentType, resp.StatusCode); err != nil {
		os.Remove(tmp)
		log.Printf("tilecache: skip caching %s: %v", safeURLForLog(fetchURL), err)
		return
	}
	log.Printf("tilecache: cached %s", safeURLForLog(fetchURL))
}

func (p *tileProxy) responseLimit() int64 {
	if validResponseLimit(p.maxResponseBytes) {
		return p.maxResponseBytes
	}
	return defaultMaxResponseBytes
}

func cacheMetadataBytes(contentType string, statusCode int) int64 {
	bytes := int64(len(contentType))
	if statusCode == http.StatusNoContent {
		bytes += int64(len(strconv.Itoa(http.StatusNoContent)))
	}
	return bytes
}

func (p *tileProxy) commitCache(tmp, cachePath, contentType string, statusCode int) error {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	for _, suffix := range []string{".ct", ".status"} {
		if err := os.Remove(cachePath + suffix); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove stale cache metadata: %w", err)
		}
	}
	metadataBytes := cacheMetadataBytes(contentType, statusCode)
	if p.maxCacheBytes > 0 {
		used, err := cacheSize(p.cacheDir)
		if err != nil {
			return fmt.Errorf("measure cache: %w", err)
		}
		// tmp is already inside cacheDir, so used is the post-rename count;
		// reserve the small sidecars that are written immediately afterwards.
		if used > p.maxCacheBytes || metadataBytes > p.maxCacheBytes-used {
			return fmt.Errorf("cache limit of %d bytes reached", p.maxCacheBytes)
		}
	}
	if err := os.Rename(tmp, cachePath); err != nil {
		return fmt.Errorf("rename cache entry: %w", err)
	}
	cleanup := func() {
		os.Remove(cachePath)
		os.Remove(cachePath + ".ct")
		os.Remove(cachePath + ".status")
	}
	if contentType != "" {
		if err := os.WriteFile(cachePath+".ct", []byte(contentType), 0o644); err != nil {
			cleanup()
			return fmt.Errorf("write content-type sidecar: %w", err)
		}
	}
	if statusCode == http.StatusNoContent {
		if err := os.WriteFile(cachePath+".status", []byte(strconv.Itoa(http.StatusNoContent)), 0o644); err != nil {
			cleanup()
			return fmt.Errorf("write status sidecar: %w", err)
		}
	}
	return nil
}

func cacheSize(dir string) (int64, error) {
	var size int64
	err := filepath.WalkDir(dir, func(_ string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		size += info.Size()
		return nil
	})
	return size, err
}

func validResponseLimit(value int64) bool {
	return value > 0 && value < maxInt64
}

func defaultLookupIP(ctx context.Context, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

func lookupHost(ctx context.Context, host string, lookup lookupIPFunc) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	if lookup == nil {
		lookup = defaultLookupIP
	}
	return lookup(ctx, host)
}

func isPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	ipv4 := ip.To4()
	if ipv4 == nil {
		// Deprecated IPv6 site-local unicast (fec0::/10) is neither private
		// nor link-local in net.IP's helpers, but must not be fetchable.
		if len(ip) == net.IPv6len && ip[0] == 0xfe && ip[1]&0xc0 == 0xc0 {
			return false
		}
		return true
	}
	if ipv4[0] == 0 || ipv4[0] == 10 || ipv4[0] == 127 || ipv4[0] >= 224 ||
		(ipv4[0] == 169 && ipv4[1] == 254) ||
		(ipv4[0] == 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
		(ipv4[0] == 192 && ipv4[1] == 168) ||
		(ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
		(ipv4[0] == 192 && ipv4[1] == 0 && ipv4[2] == 0) ||
		(ipv4[0] == 192 && ipv4[1] == 0 && ipv4[2] == 2) ||
		(ipv4[0] == 192 && ipv4[1] == 88 && ipv4[2] == 99) ||
		(ipv4[0] == 198 && (ipv4[1] == 18 || ipv4[1] == 19)) ||
		(ipv4[0] == 198 && ipv4[1] == 51 && ipv4[2] == 100) ||
		(ipv4[0] == 203 && ipv4[1] == 0 && ipv4[2] == 113) {
		return false
	}
	return true
}

func validateRemoteURL(ctx context.Context, target *url.URL, lookup lookupIPFunc) error {
	if target == nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" || target.User != nil {
		return fmt.Errorf("must be an absolute http:// or https:// URL without userinfo")
	}
	host := target.Hostname()
	if host == "" || strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return fmt.Errorf("host is not public")
	}
	ips, err := lookupHost(ctx, host, lookup)
	if err != nil {
		return fmt.Errorf("resolve host: %w", err)
	}
	for _, ip := range ips {
		if isPublicIP(ip) {
			return nil
		}
	}
	return fmt.Errorf("host does not resolve to a public address")
}

func newRemoteClient(base *http.Transport, lookup lookupIPFunc, timeout time.Duration) *http.Client {
	transport := base.Clone()
	// Direct dials are necessary so the checked endpoint cannot be changed by
	// an environment proxy after validation.
	transport.Proxy = nil
	dialer := &net.Dialer{}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := lookupHost(ctx, host, lookup)
		if err != nil {
			return nil, fmt.Errorf("resolve remote host: %w", err)
		}
		var lastErr error
		for _, ip := range ips {
			if !isPublicIP(ip) {
				continue
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("remote host has no public address")
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= maxRemoteRedirects {
				return fmt.Errorf("too many redirects")
			}
			return validateRemoteURL(request.Context(), request.URL, lookup)
		},
	}
}

func safeURLForLog(raw string) string {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme == "" || target.Host == "" {
		return "upstream"
	}
	return target.Scheme + "://" + target.Host
}

func validTile(z, x, y string) bool {
	zoom, _ := strconv.Atoi(z)
	tileX, _ := strconv.ParseUint(x, 10, 64)
	tileY, _ := strconv.ParseUint(y, 10, 64)
	if zoom > 30 {
		return false
	}
	limit := uint64(1) << uint(zoom)
	return tileX < limit && tileY < limit
}

func hasHiddenPathSegment(path string) bool {
	for {
		slash := strings.IndexByte(path, '/')
		segment := path
		if slash >= 0 {
			segment = path[:slash]
			path = path[slash+1:]
		}
		if len(segment) > 1 && segment[0] == '.' {
			return true
		}
		if slash < 0 {
			return false
		}
	}
}

func staticHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hasHiddenPathSegment(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func contentType(path string) string {
	switch filepath.Ext(path) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}
