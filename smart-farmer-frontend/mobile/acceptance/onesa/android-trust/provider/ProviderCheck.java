package eu.onesa.qualification.documents;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;

/** Checks resolver discovery, selective projections, the exact file bytes, and denied writes on the AVD. */
public final class ProviderCheck extends Instrumentation {
    private boolean verifyInstalled;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        verifyInstalled = args != null && "true".equals(args.getString("verifyInstalled"));
        start();
    }

    private static void require(boolean ok, String what) {
        if (!ok) throw new IllegalStateException(what);
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (verifyInstalled) {
                KeyStore trust = KeyStore.getInstance("AndroidCAStore");
                trust.load(null);
                byte[] expected;
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                try (InputStream cert = getTargetContext().getAssets().open(IssuerDocuments.CERT_ID)) {
                    expected = sha.digest(cert.readAllBytes());
                }
                for (String alias : Collections.list(trust.aliases())) {
                    if (alias.startsWith("user:") && MessageDigest.isEqual(expected,
                            sha.digest(trust.getCertificate(alias).getEncoded()))) {
                        result.putString("trustedIssuerProof", "exact-user-ca-sha256");
                        finish(Activity.RESULT_OK, result);
                        return;
                    }
                }
                throw new IllegalStateException("Bundled CA missing from user trust");
            }
            String authority = IssuerDocuments.AUTHORITY;
            ContentResolver resolver = getTargetContext().getContentResolver();
            try (Cursor roots = resolver.query(DocumentsContract.buildRootsUri(authority),
                    new String[]{Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID}, null, null, null)) {
                require(roots != null && roots.getCount() == 1 && roots.moveToFirst(), "missing issuer root");
                require(IssuerDocuments.NAME.equals(roots.getString(0)), "incorrect root");
                require(IssuerDocuments.ROOT_ID.equals(roots.getString(1)), "incorrect directory");
            }
            Uri children = DocumentsContract.buildChildDocumentsUri(authority, IssuerDocuments.ROOT_ID);
            try (Cursor files = resolver.query(children,
                    new String[]{Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE}, null, null, null)) {
                require(files != null && files.getCount() == 1 && files.moveToFirst(), "missing certificate");
                require(IssuerDocuments.CERT_ID.equals(files.getString(0)), "incorrect document");
                require(IssuerDocuments.MIME.equals(files.getString(1)), "incorrect MIME type");
            }
            Uri cert = DocumentsContract.buildDocumentUri(authority, IssuerDocuments.CERT_ID);
            try (InputStream actual = resolver.openInputStream(cert);
                 InputStream expected = getTargetContext().getAssets().open(IssuerDocuments.CERT_ID)) {
                require(actual != null && Arrays.equals(actual.readAllBytes(), expected.readAllBytes()), "incorrect certificate");
            }
            try (ParcelFileDescriptor unexpected = resolver.openFileDescriptor(cert, "rw")) {
                throw new IllegalStateException("certificate allowed write access");
            } catch (FileNotFoundException expected) {
                // Read-only provider.
            }
            result.putString("providerProof", "one-read-only-issuer-certificate");
            finish(Activity.RESULT_OK, result);
        } catch (Exception e) {
            result.putString("providerFailure", e.toString());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
