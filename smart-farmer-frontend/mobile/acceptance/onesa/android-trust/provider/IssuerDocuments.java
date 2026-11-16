package eu.onesa.qualification.documents;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** The Settings picker can read exactly one public, ephemeral test-issuer certificate. */
public final class IssuerDocuments extends DocumentsProvider {
    static final String AUTHORITY = "eu.onesa.qualification.documents";
    static final String ROOT_ID = "issuer";
    static final String CERT_ID = "farmer-device-ca.crt";
    static final String NAME = "Onesa test issuer";
    static final String MIME = "application/x-x509-ca-cert";
    private static final String[] ROOT_COLUMNS = {
        Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_TITLE,
        Root.COLUMN_DOCUMENT_ID, Root.COLUMN_MIME_TYPES
    };
    private static final String[] DOCUMENT_COLUMNS = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_FLAGS, Document.COLUMN_SIZE
    };
    private File certificate;

    @Override public boolean onCreate() {
        certificate = new File(getContext().getFilesDir(), CERT_ID);
        try (InputStream input = getContext().getAssets().open(CERT_ID)) {
            Files.copy(input, certificate.toPath(), StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (IOException e) {
            throw new IllegalStateException("Cannot open the bundled fixture certificate", e);
        }
    }

    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection == null ? ROOT_COLUMNS : projection);
        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(Root.COLUMN_ROOT_ID, ROOT_ID);
        row.add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY);
        row.add(Root.COLUMN_ICON, android.R.drawable.ic_lock_lock);
        row.add(Root.COLUMN_TITLE, NAME);
        row.add(Root.COLUMN_DOCUMENT_ID, ROOT_ID);
        row.add(Root.COLUMN_MIME_TYPES, MIME);
        return cursor;
    }

    @Override public Cursor queryDocument(String id, String[] projection) throws FileNotFoundException {
        if (!ROOT_ID.equals(id) && !CERT_ID.equals(id)) throw new FileNotFoundException(id);
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCUMENT_COLUMNS : projection);
        boolean directory = ROOT_ID.equals(id);
        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(Document.COLUMN_DOCUMENT_ID, id);
        row.add(Document.COLUMN_MIME_TYPE, directory ? Document.MIME_TYPE_DIR : MIME);
        row.add(Document.COLUMN_DISPLAY_NAME, directory ? NAME : CERT_ID);
        row.add(Document.COLUMN_FLAGS, 0);
        row.add(Document.COLUMN_SIZE, directory ? null : certificate.length());
        return cursor;
    }

    @Override public Cursor queryChildDocuments(String parent, String[] projection, String sortOrder)
            throws FileNotFoundException {
        if (!ROOT_ID.equals(parent)) throw new FileNotFoundException(parent);
        return queryDocument(CERT_ID, projection);
    }

    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal)
            throws FileNotFoundException {
        if (!CERT_ID.equals(id) || !"r".equals(mode)) throw new FileNotFoundException(id);
        if (signal != null) signal.throwIfCanceled();
        return ParcelFileDescriptor.open(certificate, ParcelFileDescriptor.MODE_READ_ONLY);
    }
}
