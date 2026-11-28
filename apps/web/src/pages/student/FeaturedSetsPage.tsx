import FeaturedSetsCard from '@/components/business/FeaturedSetsCard';

/** 精选题单完整列表：浅停留页独立 Tab，不混入个人中心的积分内容。 */
export default function FeaturedSetsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <FeaturedSetsCard />
    </div>
  );
}
