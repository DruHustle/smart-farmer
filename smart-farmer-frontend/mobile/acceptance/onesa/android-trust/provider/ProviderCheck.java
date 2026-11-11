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
import java.util.Arrays;

/** Checks resolver discovery, selective projections, the exact file bytes, and denied writes on the AVD. */
public final class ProviderCheck extends Instrumentation {
    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        start();
    }

    private static void require(boolean ok, String what) {
        if (!ok) throw new IllegalStateException(what);
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
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
