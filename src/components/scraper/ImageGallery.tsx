export default function ImageGallery({ images }: { images: Array<{ url: string; alt?: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {images.map((image) => (
        <div key={image.url} className="aspect-square overflow-hidden rounded-lg border border-card-border bg-white">
          <img src={image.url} alt={image.alt || ""} className="h-full w-full object-cover" />
        </div>
      ))}
    </div>
  );
}
