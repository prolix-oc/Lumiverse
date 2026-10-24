package chat.lumiverse.mobile;
import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void acceptsScreenshotAddress() {
        assertEquals("http://100.93.69.95:7860", ServerAddress.normalize(" 100.93.69.95:7860 "));
    }
    @Test public void defaultsPrivateAddressesToHttp() {
        for (String host : new String[]{"10.0.0.1", "192.168.1.2", "172.16.0.1", "172.31.255.1", "100.64.0.1", "100.127.255.1", "localhost", "[::1]"})
            assertEquals("http://" + host + ":7860", ServerAddress.normalize(host + ":7860"));
    }
    @Test public void publicAddressesDefaultToHttps() {
        for (String host : new String[]{"example.com", "8.8.8.8", "100.63.1.1", "100.128.0.1", "172.32.0.1"})
            assertEquals("https://" + host, ServerAddress.normalize(host));
    }
    @Test public void respectsExplicitProtocolAndRemovesTrailingSlash() {
        assertEquals("https://100.93.69.95:7860", ServerAddress.normalize("https://100.93.69.95:7860/"));
        assertEquals("http://example.com:7860", ServerAddress.normalize("http://example.com:7860"));
    }
    @Test public void rejectsInvalidOrigins() {
        for (String input : new String[]{"", "https://", "ftp://example.com", "https://user:pass@example.com", "example.com/chat", "example.com?x=1", "example.com#x", "example.com:99999", "example.com:0", "bad host"}) {
            try { ServerAddress.normalize(input); fail(input); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void originMatchingIncludesSchemeAndEffectivePort() {
        assertTrue(ServerAddress.sameOrigin("http://100.93.69.95:7860", "http://100.93.69.95:7860/chat"));
        assertTrue(ServerAddress.sameOrigin("https://example.com", "https://EXAMPLE.com:443/chat"));
        assertTrue(ServerAddress.sameOrigin("http://example.com", "http://example.com:80/chat"));
        assertFalse(ServerAddress.sameOrigin("https://example.com", "http://example.com"));
        assertFalse(ServerAddress.sameOrigin("http://example.com:7860", "http://example.com:7861"));
        assertFalse(ServerAddress.sameOrigin("http://example.com", "http://evil.example"));
    }
}
