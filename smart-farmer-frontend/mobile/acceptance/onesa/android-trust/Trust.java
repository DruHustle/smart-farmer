package eu.onesa.qualification;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.os.Bundle;
import java.io.InputStream;
import java.io.FileOutputStream;

/** Provision one public test CA on this disposable fully managed emulator. */
public final class Trust extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        DevicePolicyManager policy = getSystemService(DevicePolicyManager.class);
        ComponentName owner = new ComponentName(this, Owner.class);
        try (InputStream input = getAssets().open("fixture-ca.der")) {
            byte[] certificate = input.readAllBytes();
            if (!policy.isDeviceOwnerApp(getPackageName()) ||
                !policy.installCaCert(owner, certificate) || !policy.hasCaCertInstalled(owner, certificate)) {
                throw new IllegalStateException("Test CA installation failed");
            }
            try (FileOutputStream receipt = openFileOutput("installed", MODE_PRIVATE)) {
                receipt.write(1);
            }
        } catch (Exception error) {
            throw new IllegalStateException("Cannot provision the emulator test CA", error);
        } finally {
            finish();
        }
    }
}
