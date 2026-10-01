package chat.lumiverse.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class VolumePagingKeysTest {
    @Test public void disabledLeavesSystemVolumeAlone() {
        var keys = new VolumePagingKeys();
        assertEquals(0, keys.handle(24, 0, 0, false));
        assertEquals(0, keys.handle(24, 1, 0, false));
        assertEquals(0, keys.handle(25, 0, 0, false));
    }
    @Test public void pressPagesOnceAndConsumesReleaseAfterSettingChanges() {
        var keys = new VolumePagingKeys();
        assertEquals(2, keys.handle(24, 0, 0, true));
        assertEquals(1, keys.handle(24, 0, 1, true));
        assertEquals(1, keys.handle(24, 0, 2, false));
        assertEquals(1, keys.handle(24, 1, 0, false));
        assertEquals(0, keys.handle(24, 0, 0, false));
    }
    @Test public void overlappingButtonsHaveIndependentReleases() {
        var keys = new VolumePagingKeys();
        assertEquals(2, keys.handle(24, 0, 0, true));
        assertEquals(3, keys.handle(25, 0, 0, true));
        assertEquals(1, keys.handle(24, 1, 0, true));
        assertEquals(1, keys.handle(25, 1, 0, true));
        assertEquals(3, keys.handle(25, 0, 0, true));
    }
    @Test public void backgroundingClearsAnUnreleasedPress() {
        var keys = new VolumePagingKeys();
        assertEquals(2, keys.handle(24, 0, 0, true));
        keys.reset();
        assertEquals(2, keys.handle(24, 0, 0, true));
    }
    @Test public void unrelatedKeysAndUncapturedRepeatsPassThrough() {
        var keys = new VolumePagingKeys();
        assertEquals(0, keys.handle(4, 0, 0, true));
        assertEquals(0, keys.handle(25, 0, 1, true));
        assertEquals(0, keys.handle(25, 1, 0, true));
    }
}
