import java.io.*;
import com.eteks.sweethome3d.io.*;
import com.eteks.sweethome3d.model.*;
import com.eteks.sweethome3d.swing.*;
import com.eteks.sweethome3d.viewcontroller.*;
import com.eteks.sweethome3d.j3d.Object3DBranchFactory;
import javax.media.j3d.*;
import java.util.*;

public class ExportHome {
  private static class TaggedFactory extends Object3DBranchFactory {
    private final Map<String, Boolean> visibility;
    private int part = 0;
    TaggedFactory(UserPreferences preferences, Map<String, Boolean> visibility) {
      super(preferences);
      this.visibility = visibility;
    }
    private void tag(Node node, boolean visible, String source) {
      if (node instanceof Shape3D) {
        Appearance appearance = ((Shape3D)node).getAppearance();
        PolygonAttributes polygon = appearance == null ? null : appearance.getPolygonAttributes();
        String culling = polygon != null && polygon.getCullFace() == PolygonAttributes.CULL_NONE
            ? "CullNone" : "CullBack";
        String label = (visible ? "teldraVisible_" : "teldraHidden_")
            + source + "_" + culling + "_" + (++part);
        node.setUserData(label);
        node.setName(label);
      }
      if (node instanceof Group) {
        Enumeration<?> children = ((Group)node).getAllChildren();
        while (children.hasMoreElements()) tag((Node)children.nextElement(), visible, source);
      }
    }
    @Override public Object createObject3D(Home home, Selectable item,
        UserPreferences preferences, Object context, boolean wait) {
      Object result = super.createObject3D(home, item, preferences, context, wait);
      Level level = item instanceof Elevatable ? ((Elevatable)item).getLevel() : null;
      boolean visible = level == null || !Boolean.FALSE.equals(visibility.get(level.getId()));
      String source = item instanceof HomeObject ? ((HomeObject)item).getId() : "presentation";
      if (result instanceof Node) tag((Node)result, visible, source.replaceAll("[^A-Za-z0-9_]", "_"));
      return result;
    }
  }
  private static class ExportPane extends HomePane {
    ExportPane(Home home, UserPreferences preferences, HomeController controller) {
      super(home, preferences, controller);
    }
    void exportTagged(String destination, Object3DFactory factory) throws RecorderException {
      super.exportToOBJ(destination, factory);
    }
  }
  public static void main(String[] args) throws Exception {
    // The caller supplies a ZIP without a serialized Home entry. XML only.
    Home home;
    try (DefaultHomeInputStream input = new DefaultHomeInputStream(
        new File(args[0]), ContentRecording.INCLUDE_ALL_CONTENT,
        new HomeXMLHandler(), null, false)) {
      home = input.readHome();
    }
    UserPreferences preferences = new DefaultUserPreferences();
    Map<String, Boolean> visibility = new HashMap<String, Boolean>();
    for (Level level : home.getLevels()) {
      visibility.put(level.getId(), level.isVisible());
      level.setVisible(true);
    }
    HomeController controller = new HomeController(home, preferences, new SwingViewFactory());
    new ExportPane(home, preferences, controller).exportTagged(args[1],
        new TaggedFactory(preferences, visibility));
    System.out.println("EXPORTED furniture=" + home.getFurniture().size()
        + " walls=" + home.getWalls().size() + " rooms=" + home.getRooms().size());
    System.exit(0);
  }
}
