package com.example.bridge.forestry;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
class NaturalWoodLedgerTest {
    private final UUID world=UUID.randomUUID();
    private NaturalWoodLedger.Pos pos(int x,int y) { return new NaturalWoodLedger.Pos(world,x,y,0); }
    private Map<NaturalWoodLedger.Pos,String> tree() { return Map.of(pos(0,1),"OAK_LOG",pos(0,2),"OAK_LOG",pos(0,3),"OAK_LOG"); }
    @Test void unknownIsNeverNatural() { assertNull(new NaturalWoodLedger().get(pos(0,1))); }
    @Test void growthAndNearbyBuildingInvalidateWholeTree() { var l=new NaturalWoodLedger();assertTrue(l.record(tree()));assertNotNull(l.get(pos(0,3)));l.invalidateNear(pos(2,2));assertNull(l.get(pos(0,1)));assertNull(l.get(pos(0,3))); }
    @Test void rejectsBranchesAndGaps() { var l=new NaturalWoodLedger();assertFalse(l.record(Map.of(pos(0,1),"OAK_LOG",pos(1,2),"OAK_LOG",pos(0,3),"OAK_LOG")));assertFalse(l.record(Map.of(pos(0,1),"OAK_LOG",pos(0,3),"OAK_LOG",pos(0,4),"OAK_LOG"))); }
    @Test void harvestedLogDoesNotAuthorizeReplacement() { var l=new NaturalWoodLedger();l.record(tree());l.remove(pos(0,3));assertNull(l.get(pos(0,3)));assertNotNull(l.get(pos(0,1))); }
}
