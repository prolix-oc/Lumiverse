package chat.lumiverse.mobile;

import java.net.URI;
import java.util.Locale;

final class ServerAddress {
    static String normalize(String input) {
        String value = input.trim();
        if (!value.contains("://")) {
            URI candidate = URI.create("http://" + value);
            value = (isPrivateHost(candidate.getHost()) ? "http://" : "https://") + value;
        }
        URI url = URI.create(value);
        String scheme = url.getScheme().toLowerCase(Locale.ROOT);
        if ((!scheme.equals("https") && !scheme.equals("http")) || url.getHost() == null
            || url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null
            || (url.getRawPath() != null && !url.getRawPath().isEmpty() && !url.getRawPath().equals("/"))
            || url.getPort() < -1 || url.getPort() == 0 || url.getPort() > 65535) {
            throw new IllegalArgumentException("Invalid server origin");
        }
        return scheme + "://" + url.getRawAuthority().toLowerCase(Locale.ROOT);
    }

    private static boolean isPrivateHost(String host) {
        if (host == null) return false;
        if (host.equalsIgnoreCase("localhost") || host.equals("[::1]")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                if (!parts[i].matches("[0-9]{1,3}")) return false;
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] > 255) return false;
            }
        } catch (NumberFormatException error) { return false; }
        return octets[0] == 10 || octets[0] == 127
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }

    static boolean sameOrigin(String selected, String candidate) {
        try {
            URI a = URI.create(selected), b = URI.create(candidate);
            return a.getHost() != null && b.getHost() != null
                && a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (IllegalArgumentException error) { return false; }
    }

    private static int port(URI url) {
        return url.getPort() == -1 ? ("https".equalsIgnoreCase(url.getScheme()) ? 443 : 80) : url.getPort();
    }
}
