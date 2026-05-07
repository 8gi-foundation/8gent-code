import { Composition } from 'remotion';
import { TokyoToSF } from './compositions/TokyoToSF';

export const RemotionRoot: React.FC = () => {
	return (
		<>
			<Composition
				id="TokyoToSF"
				component={TokyoToSF}
				durationInFrames={240}
				fps={30}
				width={1920}
				height={1080}
			/>
		</>
	);
};
