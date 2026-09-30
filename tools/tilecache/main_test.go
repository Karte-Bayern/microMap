package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func publicLookup(context.Context, string) ([]net.IP, error) {
	return []net.IP{net.ParseIP("93.184.216.34")}, nil
}

func TestKarteBayernLiveResponsesKeepImageryHeadersWithoutDiskCache(t *testing.T) {
	var hits int
	proxy := &tileProxy{
		cacheDir:  t.TempDir(),
		lookupIP:  publicLookup,
		userAgent: "test-tilecache",
		remoteClient: &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
			hits++
			if r.URL.Host != "karte.bayern" || r.Header.Get("Referer") != "" {
				t.Errorf("unexpected upstream request: %s, referer %q", r.URL, r.Header.Get("Referer"))
			}
			header := make(http.Header)
			header.Set("Content-Type", "image/jpeg")
			header.Set("X-KB-Imagery-Attribution", "Bayerische Vermessungsverwaltung; Bearbeitung: Test")
			return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(strings.NewReader("image")), ContentLength: 5}, nil
		})},
	}
	target := "https://karte.bayern/sat/12/2190/1413?fmt=webp"
	for i := 0; i < 2; i++ {
		request := httptest.NewRequest(http.MethodGet, "/fetch?u="+url.QueryEscape(target), nil)
		response := httptest.NewRecorder()
		proxy.handleFetch(response, request)
		if response.Code != http.StatusOK || response.Body.String() != "image" {
			t.Fatalf("response %d: status %d, body %q", i, response.Code, response.Body.String())
		}
		if got := response.Header().Get("X-KB-Imagery-Attribution"); got != "Bayerische Vermessungsverwaltung; Bearbeitung: Test" {
			t.Fatalf("missing imagery provenance: %q", got)
		}
		if got := response.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("unexpected cache policy: %q", got)
		}
	}
	if hits != 2 {
		t.Fatalf("expected two live upstream requests, got %d", hits)
	}
	request := httptest.NewRequest(http.MethodHead, "/fetch?u="+url.QueryEscape(target), nil)
	response := httptest.NewRecorder()
	proxy.handleFetch(response, request)
	if response.Code != http.StatusOK || response.Body.Len() != 0 || response.Header().Get("X-KB-Imagery-Attribution") == "" {
		t.Fatalf("HEAD did not preserve headers without a body: status %d, body %q", response.Code, response.Body.String())
	}
	if entries, err := os.ReadDir(proxy.cacheDir); err != nil || len(entries) != 0 {
		t.Fatalf("live responses must not be cached: %v, %v", entries, err)
	}
}

func TestKarteBayernVolatileURLScope(t *testing.T) {
	for _, test := range []struct {
		url  string
		want bool
	}{
		{"https://karte.bayern/tilejson.json", true},
		{"https://karte.bayern/api/orthophoto/sources?scope=runtime", true},
		{"https://karte.bayern/sat/12/2190/1413?fmt=webp", true},
		{"https://karte.bayern/tiles/12/2190/1413.mvt?kb_tile_rev=abc", false},
		{"https://karte.bayern/api/orthophoto/sources?scope=catalog", false},
		{"https://other.example/sat/12/2190/1413", false},
	} {
		target, err := url.Parse(test.url)
		if err != nil {
			t.Fatal(err)
		}
		if got := volatileKarteBayernURL(target); got != test.want {
			t.Errorf("volatileKarteBayernURL(%q) = %v, want %v", test.url, got, test.want)
		}
	}
}

func TestServesFromCacheAfterFirstFetch(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("fake-tile-bytes"))
	}))
	defer upstream.Close()

	dir := t.TempDir()
	proxy := &tileProxy{
		upstream:  upstream.URL,
		cacheDir:  dir,
		userAgent: "test",
		client:    upstream.Client(),
		sem:       make(chan struct{}, 2),
		inflight:  make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handle))
	defer server.Close()

	for i := 0; i < 3; i++ {
		resp, err := http.Get(server.URL + "/12/2186/1410.png")
		if err != nil {
			t.Fatal(err)
		}
		body := make([]byte, 64)
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		if string(body[:n]) != "fake-tile-bytes" {
			t.Fatalf("unexpected body: %q", body[:n])
		}
	}

	if hits != 1 {
		t.Fatalf("expected exactly 1 upstream fetch, got %d", hits)
	}

	if _, err := os.Stat(dir + "/12/2186/1410.png"); err != nil {
		t.Fatalf("tile was not cached on disk: %v", err)
	}
}

func TestRejectsUnrecognizedPaths(t *testing.T) {
	proxy := &tileProxy{
		upstream: "http://example.invalid",
		cacheDir: t.TempDir(),
		client:   http.DefaultClient,
		sem:      make(chan struct{}, 1),
		inflight: make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handle))
	defer server.Close()

	resp, err := http.Get(server.URL + "/../../etc/passwd")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for a non-tile path, got %d", resp.StatusCode)
	}
}

func TestCoalescesConcurrentCacheMisses(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		time.Sleep(40 * time.Millisecond)
		w.Write([]byte("one-tile"))
	}))
	defer upstream.Close()

	proxy := &tileProxy{
		upstream: upstream.URL,
		cacheDir: t.TempDir(),
		client:   upstream.Client(),
		sem:      make(chan struct{}, 2),
		inflight: make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handle))
	defer server.Close()

	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			resp, err := http.Get(server.URL + "/4/8/7.png")
			if err != nil {
				t.Error(err)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("expected 200, got %d", resp.StatusCode)
			}
			io.Copy(io.Discard, resp.Body)
		}()
	}
	group.Wait()
	if hits != 1 {
		t.Fatalf("expected one upstream request, got %d", hits)
	}
}

func TestRejectsOutOfRangeTilesAndHiddenStaticFiles(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	proxy := &tileProxy{
		upstream: "http://example.invalid",
		cacheDir: t.TempDir(),
		client:   http.DefaultClient,
		sem:      make(chan struct{}, 1),
		inflight: make(map[string]chan struct{}),
		static:   staticHandler(staticDir),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handle))
	defer server.Close()

	for _, requestPath := range []string{"/31/0/0.png", "/3/8/0.png", "/3/0/8.png", "/.git/config"} {
		resp, err := http.Get(server.URL + requestPath)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 for %s, got %d", requestPath, resp.StatusCode)
		}
	}

	resp, err := http.Get(server.URL + "/index.html")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected static file, got %d", resp.StatusCode)
	}
}

func TestGenericFetchCachesArbitraryURLsWithContentType(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Write([]byte("fake-mvt-bytes"))
	}))
	defer upstream.Close()

	proxy := &tileProxy{
		upstream:     "http://unused.invalid",
		cacheDir:     t.TempDir(),
		client:       upstream.Client(),
		lookupIP:     publicLookup,
		remoteClient: testRemoteClient(t, upstream.URL),
		sem:          make(chan struct{}, 2),
		inflight:     make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handleFetch))
	defer server.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := "http://tiles.example:" + upstreamURL.Port() + "/tiles/4/8/7.mvt?key=abc"
	for i := 0; i < 3; i++ {
		resp, err := http.Get(server.URL + "/fetch?u=" + url.QueryEscape(target))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != "fake-mvt-bytes" {
			t.Fatalf("unexpected body: %q", body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "application/vnd.mapbox-vector-tile" {
			t.Fatalf("unexpected content-type: %q", ct)
		}
	}
	if hits != 1 {
		t.Fatalf("expected exactly 1 upstream fetch, got %d", hits)
	}
}

func testRemoteClient(t *testing.T, serverURL string) *http.Client {
	t.Helper()
	target, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, target.Host)
		},
	}}
}

func TestGenericFetchRejectsNonHTTPURLs(t *testing.T) {
	proxy := &tileProxy{
		upstream: "http://unused.invalid",
		cacheDir: t.TempDir(),
		client:   http.DefaultClient,
		sem:      make(chan struct{}, 1),
		inflight: make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handleFetch))
	defer server.Close()

	for _, requestPath := range []string{"/fetch", "/fetch?u=not-a-url", "/fetch?u=" + url.QueryEscape("file:///etc/passwd")} {
		resp, err := http.Get(server.URL + requestPath)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400 for %s, got %d", requestPath, resp.StatusCode)
		}
	}
}

func TestGenericFetchRejectsPrivateTargetsAndUserinfo(t *testing.T) {
	proxy := &tileProxy{
		upstream: "http://unused.invalid",
		cacheDir: t.TempDir(),
		client:   http.DefaultClient,
		lookupIP: func(_ context.Context, host string) ([]net.IP, error) {
			if host == "private.example" {
				return []net.IP{net.ParseIP("10.0.0.1")}, nil
			}
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		},
		sem:      make(chan struct{}, 1),
		inflight: make(map[string]chan struct{}),
	}
	server := httptest.NewServer(http.HandlerFunc(proxy.handleFetch))
	defer server.Close()

	for _, target := range []string{
		"http://127.0.0.1/internal",
		"http://[::1]/internal",
		"http://[fec0::1]/internal",
		"http://169.254.169.254/latest/meta-data",
		"http://private.example/tiles/0/0/0.mvt",
	} {
		resp, err := http.Get(server.URL + "/fetch?u=" + url.QueryEscape(target))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 for %s, got %d", target, resp.StatusCode)
		}
	}

	resp, err := http.Get(server.URL + "/fetch?u=" + url.QueryEscape("https://token@example.com/tiles/0/0/0.mvt"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for userinfo URL, got %d", resp.StatusCode)
	}
}

func TestRemoteClientChecksRedirectsAndDNSAtDialTime(t *testing.T) {
	privateLookup := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	client := newRemoteClient(http.DefaultTransport.(*http.Transport), privateLookup, time.Second)
	redirect, err := http.NewRequest(http.MethodGet, "https://private.example/next", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(redirect, nil); err == nil {
		t.Fatal("redirect to a private target was accepted")
	}
	if _, err := client.Get("http://rebound.example/tile"); err == nil {
		t.Fatal("dial to a private rebinding target was accepted")
	}
}

func TestPublicIPPolicyRejectsInternalIPv4AndIPv6Forms(t *testing.T) {
	for _, raw := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1",
		"::1", "::ffff:127.0.0.1", "fe80::1", "fec0::1",
	} {
		if isPublicIP(net.ParseIP(raw)) {
			t.Fatalf("internal address %s was accepted", raw)
		}
	}
	if !isPublicIP(net.ParseIP("93.184.216.34")) || !isPublicIP(net.ParseIP("2606:2800:220:1:248:1893:25c8:1946")) {
		t.Fatal("known public addresses were rejected")
	}
}

func TestFetchRejectsResponsesOverTheConfiguredLimit(t *testing.T) {
	for _, contentLength := range []int64{5, -1} {
		dir := t.TempDir()
		proxy := &tileProxy{cacheDir: dir, userAgent: "test", maxResponseBytes: 4}
		client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				ContentLength: contentLength,
				Header:        make(http.Header),
				Body:          io.NopCloser(strings.NewReader("12345")),
			}, nil
		})}
		cachePath := filepath.Join(dir, "oversized")
		proxy.fetch(cachePath, "https://tiles.example/secret-token", client)
		if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
			t.Fatalf("content length %d left a cache file: %v", contentLength, err)
		}
	}
}

func TestFetchRejectsOversizedContentTypeMetadata(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		limit   int64
		content string
	}{
		{name: "metadata counts toward response limit", limit: 4, content: "abcde"},
		{name: "content type has its own compact bound", limit: 1024, content: strings.Repeat("a", maxContentTypeBytes+1)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			proxy := &tileProxy{cacheDir: dir, userAgent: "test", maxResponseBytes: testCase.limit}
			client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode:    http.StatusOK,
					Status:        "200 OK",
					ContentLength: 0,
					Header:        http.Header{"Content-Type": []string{testCase.content}},
					Body:          io.NopCloser(strings.NewReader("")),
				}, nil
			})}
			cachePath := filepath.Join(dir, "oversized-content-type")
			proxy.fetch(cachePath, "https://tiles.example/secret-token", client)
			if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
				t.Fatalf("oversized content-type left a cache file: %v", err)
			}
		})
	}
}

func TestCachedNoContentPreservesItsStatus(t *testing.T) {
	dir := t.TempDir()
	proxy := &tileProxy{cacheDir: dir, userAgent: "test", maxResponseBytes: 64, maxCacheBytes: 64}
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusNoContent,
			Status:        "204 No Content",
			ContentLength: 0,
			Header:        http.Header{"Content-Type": []string{"application/vnd.mapbox-vector-tile"}},
			Body:          io.NopCloser(strings.NewReader("")),
		}, nil
	})}
	cachePath := filepath.Join(dir, "empty-tile")
	proxy.fetch(cachePath, "https://tiles.example/empty", client)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://tilecache.test/fetch", nil)
	if !proxy.serveIfCached(recorder, request, cachePath) {
		t.Fatal("204 response was not cached")
	}
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("cached 204 became %d", recorder.Code)
	}
}

func TestValidResponseLimitRejectsMaxInt64(t *testing.T) {
	if validResponseLimit(maxInt64) {
		t.Fatal("MaxInt64 would overflow the bounded reader")
	}
	if !validResponseLimit(maxInt64 - 1) {
		t.Fatal("the largest safe limit was rejected")
	}
	if got := (&tileProxy{maxResponseBytes: maxInt64}).responseLimit(); got != defaultMaxResponseBytes {
		t.Fatalf("invalid direct response limit fell through as %d", got)
	}
}

func TestFetchRejectsEntriesThatExceedTheTotalCacheLimit(t *testing.T) {
	dir := t.TempDir()
	proxy := &tileProxy{
		cacheDir:         dir,
		userAgent:        "test",
		maxResponseBytes: 6,
		maxCacheBytes:    4,
	}
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			Status:        "200 OK",
			ContentLength: 5,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader("12345")),
		}, nil
	})}
	cachePath := filepath.Join(dir, "over-total-limit")
	proxy.fetch(cachePath, "https://tiles.example/secret-token", client)
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("total cache limit left a cache file: %v", err)
	}
}

func TestHasHiddenPathSegment(t *testing.T) {
	cases := map[string]bool{
		"/index.html":      false,
		"/demo/":           false,
		"/demo/index.html": false,
		"/.git/config":     true,
		"/demo/.env":       true,
		"/a/.b/c":          true,
		"/":                false,
		"":                 false,
		"/..":              true,
		"/a.b/c":           false,
	}
	for path, want := range cases {
		if got := hasHiddenPathSegment(path); got != want {
			t.Errorf("hasHiddenPathSegment(%q) = %v, want %v", path, got, want)
		}
	}
}
