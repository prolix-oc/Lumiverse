package chat.lumiverse.mobile;

/** Keeps a captured press consumed through key-up, even if focus or settings change. */
final class VolumePagingKeys {
    static final int PASS = 0, CONSUME = 1, UP = 2, DOWN = 3;
    private final boolean[] captured = new boolean[2];

    void reset() { captured[0] = false; captured[1] = false; }

    int handle(int keyCode, int action, int repeats, boolean enabled) {
        // Android KeyEvent: VOLUME_UP=24, VOLUME_DOWN=25, DOWN=0, UP=1.
        int index = keyCode - 24;
        if (index < 0 || index > 1) return PASS;
        if (action == 1) {
            boolean wasCaptured = captured[index];
            captured[index] = false;
            return wasCaptured ? CONSUME : PASS;
        }
        if (action != 0) return PASS;
        if (captured[index]) return CONSUME;
        if (!enabled || repeats != 0) return PASS;
        captured[index] = true;
        return index == 0 ? UP : DOWN;
    }
}
